/** Phase 16 public endpoints against real PostgreSQL, with enforced runtime RLS.
 * Only Redis's network and outbound mail are replaced; validation, guards,
 * transactions, token lifecycle, password hashing and sessions run for real.
 * PHASE16_PREVIEW=1 explicitly enables a loopback-only disposable browser fixture.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { AuditDispatcher } from '../src/auth/audit-dispatcher.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage } from '../src/mail/mail-transport.js';

import { AppModule } from '../src/app.module.js';
import { API_PREFIX } from '../src/api-prefix.js';
import type { AppInfo } from '../src/app.tokens.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

// Every migration, not only Phase 3's: the application under test reads the
// tables later phases add (see `migrations.ts`).
const MIGRATIONS_SQL = allMigrationsSql();

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let redis: FakeRedis;

const messages: MailMessage[] = [];
let failMail = false;
const transport = {
  send: async (message: MailMessage): Promise<void> => {
    if (failMail) throw new Error('private SMTP failure with secret credentials');
    messages.push(message);
    if (process.env.PHASE16_PREVIEW === '1')
      writeFileSync('/private/tmp/ufuq-phase16-mail.json', JSON.stringify(messages), {
        mode: 0o600,
      });
  },
};
const COMPANY_A = generateId();
const COMPANY_B = generateId();
const ADMIN_A_EMAIL = 'admin-a@company-a.test';
const ADMIN_A_PASSWORD = 'a-genuinely-long-password-one';
const ADMIN_B_EMAIL = 'admin-b@company-b.test';
const ADMIN_B_PASSWORD = 'a-genuinely-long-password-two';
const OWNER_KEY = 'owner-key-for-tests-'.padEnd(48, 'x');
const OWNER_EMAIL = 'owner@1to1os.test';

function testEnv(databaseUrl: string): Env {
  return {
    nodeEnv: 'test',
    databaseUrl,
    redisUrl: 'redis://unused.invalid:6379',
    storage: {
      endpoint: 'http://unused.invalid:9000',
      region: 'us-east-1',
      bucket: 'unused',
      accessKeyId: 'unused',
      secretAccessKey: 'unused',
      forcePathStyle: true,
      maxUploadBytes: 10 * 1024 * 1024,
    },
    // Nothing in this suite sends mail; the transport is never contacted.
    mail: {
      smtpHost: 'unused.invalid',
      smtpPort: 1025,
      smtpSecure: false,
      smtpUser: null,
      smtpPassword: null,
      from: '1to1OS <no-reply@1to1os.test>',
      contactTo: 'contact@ufuq.test',
    },
    owner: { accessKey: OWNER_KEY, notifyTo: OWNER_EMAIL },
    apiPort: 0,
    webPort: 0,
    webOrigin: 'http://localhost:3000',
  };
}

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

async function seedFixtures(prisma: PrismaClient): Promise<void> {
  const permissionIdByKey = new Map<string, string>();
  const roleIdByKey = new Map<string, string>();

  await withPlatformContext(prisma, async (tx) => {
    for (const permission of PERMISSIONS) {
      const row = await tx.permission.create({
        data: {
          id: generateId(),
          key: permission.key,
          module: permission.module,
          descriptionEn: permission.descriptionEn,
          descriptionAr: permission.descriptionAr,
        },
      });
      permissionIdByKey.set(permission.key, row.id);
    }
    for (const role of SYSTEM_ROLES) {
      const row = await tx.role.create({
        data: {
          id: generateId(),
          companyId: null,
          key: role.key,
          nameEn: role.nameEn,
          nameAr: role.nameAr,
          isSystem: true,
        },
      });
      roleIdByKey.set(role.key, row.id);
    }
    for (const grant of ROLE_PERMISSIONS) {
      await tx.rolePermission.create({
        data: {
          roleId: roleIdByKey.get(grant.role) as string,
          permissionId: permissionIdByKey.get(grant.permission) as string,
          scope: grant.scope,
        },
      });
    }
  });

  const roleAdminId = roleIdByKey.get('admin') as string;
  const [hashA, hashB] = await Promise.all([
    hashPassword(ADMIN_A_PASSWORD),
    hashPassword(ADMIN_B_PASSWORD),
  ]);

  await withTenant(prisma, COMPANY_A, (tx) =>
    tx.company.create({
      data: { id: COMPANY_A, name: 'Company A', slug: 'company-a', timezone: 'Africa/Cairo' },
    }),
  );
  await withTenant(prisma, COMPANY_B, (tx) =>
    tx.company.create({
      data: { id: COMPANY_B, name: 'Company B', slug: 'company-b', timezone: 'Africa/Cairo' },
    }),
  );
  await withTenant(prisma, COMPANY_A, (tx) =>
    tx.user.create({
      data: {
        id: generateId(),
        companyId: COMPANY_A,
        email: ADMIN_A_EMAIL,
        passwordHash: hashA,
        roleId: roleAdminId,
        status: 'active',
      },
    }),
  );
  await withTenant(prisma, COMPANY_B, (tx) =>
    tx.user.create({
      data: {
        id: generateId(),
        companyId: COMPANY_B,
        email: ADMIN_B_EMAIL,
        passwordHash: hashB,
        roleId: roleAdminId,
        status: 'active',
      },
    }),
  );
}

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.exec(MIGRATIONS_SQL);
  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  let port = 0;
  socket.addEventListener('listening', (event) => {
    port = (event as Event & { detail: { port: number } }).detail.port;
  });
  await socket.start();

  redis = new FakeRedis();

  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register(
        testEnv(`postgresql://postgres@127.0.0.1:${port}/postgres?connection_limit=1`),
        APP_INFO,
        { backgroundJobs: false },
      ),
    ],
  })
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(transport)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  // Listening once, here, matters: given a server that is not listening,
  // supertest listens for each request and closes the server after it, and
  // a request that starts while that close is in progress fails with
  // "socket hang up". `listen` also runs `init`.
  app.enableCors({ origin: 'http://localhost:3000', credentials: true });
  await app.listen(process.env.PHASE16_PREVIEW === '1' ? 4000 : 0, '127.0.0.1');

  const prisma = app.get<PrismaClient>(PRISMA_CLIENT);

  // Fixtures are seeded as the bootstrap superuser — exactly as
  // `packages/db/prisma/seed.ts` does in a real deployment, connected
  // through `DATABASE_MIGRATION_URL` rather than `DATABASE_URL`, since
  // seeding `permissions`/`role_permissions` is an operator action the
  // migration grants `ufuq_app` only read access to (see that file).
  await seedFixtures(prisma);

  // *After* seeding, and before any HTTP request is served: switch to the
  // restricted runtime role every real request handler runs as. See the
  // file header — a real `ufuq_app` login does this at the protocol level;
  // here it is done explicitly, once, with `SET ROLE`.
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
}, 30_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

async function inspect<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  return pglite.transaction(async (tx) => {
    await tx.exec('SET LOCAL ROLE postgres');
    return tx.query<T>(sql, params);
  });
}
const contact = (): Record<string, unknown> => ({
  name: 'سارة Test',
  company: 'أُفق للتجارة',
  email: 'Sara@Example.test',
  phone: '+٢٠١٠٠٠٠٠٠٠٠٠',
  enquiry_type: 'pricing',
  message: 'أحتاج إلى تنظيم الحضور والرواتب. Please contact me.',
  started_at: Date.now() - 3000,
  website: '',
});
const registration = (email = 'founder@new-company.test'): Record<string, unknown> => ({
  company_name: 'شركة جديدة',
  admin_name: 'المسؤول الأول',
  email,
  phone: '+201000000001',
  employee_count_range: '11-50',
  password: 'a-safe-registration-passphrase',
  started_at: Date.now() - 3000,
  website: '',
});
const post = (path: string, body: object): request.Test =>
  request(app.getHttpServer()).post(`/api/v1/public/${path}`).send(body);
beforeEach(() => {
  redis.reset();
  messages.length = 0;
  failMail = false;
  vi.restoreAllMocks();
});

describe('Phase 16 contact delivery', () => {
  it('delivers bilingual fields to configured recipient with validated Reply-To', async () => {
    const res = await post('contact', contact());
    expect(res.status).toBe(200);
    const message = messages[0];
    expect(message?.to).toBe('contact@ufuq.test');
    expect(message?.replyTo).toBe('sara@example.test');
    for (const field of [
      'pricing',
      'سارة Test',
      'أُفق للتجارة',
      '+201000000000',
      'sara@example.test',
      'Please contact me.',
    ])
      expect(message?.text).toContain(field);
    expect(message?.html).toContain('dir="auto"');
    expect(res.text).not.toContain('sara');
  });
  it('does not acknowledge success before the transport accepts', async () => {
    let accept!: () => void;
    let settled = false;
    const spy = vi.spyOn(transport, 'send').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    const pending = post('contact', contact()).then((res) => {
      settled = true;
      return res;
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(settled).toBe(false);
    accept();
    expect((await pending).status).toBe(200);
  });
  it('returns a generic retryable 503 on SMTP failure and permits retry', async () => {
    failMail = true;
    const res = await post('contact', contact());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CONTACT_DELIVERY_FAILED');
    expect(res.text).not.toMatch(/private|credentials|SMTP/);
    failMail = false;
    expect((await post('contact', contact())).status).toBe(200);
  });
  it('escapes HTML and leaves submitted text inert', async () => {
    const res = await post('contact', {
      ...contact(),
      message: '<script>alert("x")</script> & مرحباً',
    });
    expect(res.status).toBe(200);
    expect(messages[0]?.html).not.toContain('<script>');
    expect(messages[0]?.html).toContain('&lt;script&gt;');
  });
  it.each([
    ['name', ''],
    ['company', ''],
    ['email', 'invalid'],
    ['email', 'a@test.test\r\nBcc: victim@test.test'],
    ['phone', '-----'],
    ['enquiry_type', 'admin'],
    ['message', 'short'],
    ['message', 'x'.repeat(5001)],
    ['name', 'bad\nheader'],
    ['website', 'spam'],
    ['started_at', Date.now() + 60000],
    ['started_at', 0],
    ['role', 'admin'],
  ])('rejects invalid or malicious %s', async (field, value) => {
    expect((await post('contact', { ...contact(), [field]: value })).status).toBe(422);
    expect(messages).toHaveLength(0);
  });
  it('requires fields and rejects unknown tenant input', async () => {
    expect((await post('contact', {})).status).toBe(422);
    expect((await post('contact', { ...contact(), company_id: COMPANY_A })).status).toBe(422);
  });
  it('rate limits and supplies Retry-After', async () => {
    for (let i = 0; i < 5; i++) expect((await post('contact', contact())).status).toBe(200);
    const res = await post('contact', contact());
    expect(res.status).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(messages).toHaveLength(5);
  });
  it('refuses a cross-origin public submission', async () => {
    const res = await post('contact', contact()).set('Origin', 'https://attacker.test');
    expect(res.status).toBe(422);
    expect(messages).toHaveLength(0);
  });
});

const owner = (method: 'get' | 'post', path = '', key: string | null = OWNER_KEY): request.Test => {
  const req = request(app.getHttpServer())[method](`/api/v1/owner/signup-requests${path}`);
  return key === null ? req : req.set('x-owner-key', key);
};
const login = (email: string, password = registration().password as string): request.Test =>
  request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password });
async function companyOf(email: string): Promise<{ id: string; status: string }> {
  const rows = await inspect<{ id: string; status: string }>(
    'SELECT c.id, c.status::text AS status FROM companies c JOIN users u ON u.company_id = c.id WHERE u.email = $1',
    [email],
  );
  return rows.rows[0] as { id: string; status: string };
}

describe('Sign-up approval — registration waits for the platform owner', () => {
  it('saves a pending company and ADMIN, emails the owner, and signs in only after approval', async () => {
    const res = await post('register', registration());
    expect(res.status).toBe(201);
    expect(res.text).not.toMatch(/password|token|company_id/);
    const users = await inspect<{
      id: string;
      company_id: string;
      status: string;
      display_name: string;
      phone: string;
    }>("SELECT * FROM users WHERE email='founder@new-company.test'");
    const user = users.rows[0];
    expect(user?.status).toBe('active');
    expect(user?.display_name).toBe('المسؤول الأول');
    expect(user?.phone).toBe('+201000000001');
    const company = await companyOf('founder@new-company.test');
    expect(company.status).toBe('pending_approval');
    const companies = await inspect<{ created_by: string; employee_count_range: string }>(
      'SELECT created_by,employee_count_range FROM companies WHERE id=$1',
      [company.id],
    );
    expect(companies.rows[0]?.created_by).toBe(user?.id);
    expect(companies.rows[0]?.employee_count_range).toBe('11-50');
    const audit = await inspect<{ action: string }>(
      'SELECT action::text AS action FROM audit_logs WHERE company_id=$1',
      [company.id],
    );
    expect(audit.rows.map((r) => r.action)).toContain('signup.requested');

    // The owner hears about it; the visitor gets no email.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe(OWNER_EMAIL);
    expect(messages[0]?.replyTo).toBe('founder@new-company.test');
    expect(messages[0]?.subject).toContain('شركة جديدة');
    const link = /http:\/\/localhost:3000\/en\/owner#[^\s]+/.exec(messages[0]?.text ?? '')?.[0];
    const hash = new URLSearchParams(new URL(link as string).hash.slice(1));
    expect(hash.get('key')).toBe(OWNER_KEY);
    expect(hash.get('request')).toBe(company.id);

    // Correct password, but not approved yet.
    const blocked = await login('founder@new-company.test');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_PENDING_APPROVAL');
    expect(blocked.body.error.message_en).toContain('1–2 days');
    // A wrong password still says only that.
    expect((await login('founder@new-company.test', 'wrong-password-here')).body.error.code).toBe(
      'INVALID_CREDENTIALS',
    );

    const list = await owner('get');
    expect(list.status).toBe(200);
    const row = (list.body.data as { company_id: string }[]).find(
      (r) => r.company_id === company.id,
    );
    expect(row).toMatchObject({
      status: 'pending_approval',
      admin_email: 'founder@new-company.test',
    });

    const approved = await owner('post', `/${company.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('active');
    expect(approved.body.data.reviewed_at).toBeTruthy();
    expect((await companyOf('founder@new-company.test')).status).toBe('active');
    expect(messages).toHaveLength(2);
    expect(messages[1]?.to).toBe('founder@new-company.test');
    expect(messages[1]?.text).toContain('http://localhost:3000/ar/login');
    const reviewAudit = await inspect<{ action: string }>(
      'SELECT action::text AS action FROM audit_logs WHERE company_id=$1',
      [company.id],
    );
    expect(reviewAudit.rows.map((r) => r.action)).toContain('signup.approved');

    const agent = request.agent(app.getHttpServer());
    const signedIn = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'founder@new-company.test', password: registration().password });
    expect(signedIn.status).toBe(200);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.role.key).toBe('admin');
    expect(me.body.data.employee).toBeNull();
    expect(me.body.data.company.name).toBe('شركة جديدة');
    expect((await agent.get('/api/v1/company')).status).toBe(200);
    expect((await agent.get('/api/v1/employees')).body.data).toEqual([]);

    // Deciding twice is a conflict; registering the same email again too.
    expect((await owner('post', `/${company.id}/approve`)).status).toBe(409);
    expect((await owner('post', `/${company.id}/reject`)).status).toBe(409);
    expect((await post('register', registration())).status).toBe(409);
  });
  it('keeps a rejected company out', async () => {
    expect((await post('register', registration('rejected@new.test'))).status).toBe(201);
    const company = await companyOf('rejected@new.test');
    const res = await owner('post', `/${company.id}/reject`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('rejected');
    const blocked = await login('rejected@new.test');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_REJECTED');
    expect(messages).toHaveLength(1); // the owner notice only — no approval email
  });
  it('requires the owner key, and rate limits wrong ones', async () => {
    expect((await owner('get', '', null)).status).toBe(401);
    expect((await owner('get', '', 'x'.repeat(48))).status).toBe(401);
    expect((await owner('post', `/${COMPANY_A}/approve`, null)).status).toBe(401);
    for (let i = 0; i < 7; i++) await owner('get', '', `wrong-${String(i)}`.padEnd(40, 'z'));
    const limited = await owner('get', '', 'still-wrong'.padEnd(40, 'z'));
    expect(limited.status).toBe(429);
    expect((await owner('get')).status).toBe(200);
  });
  it('only lists public sign-ups, never existing companies', async () => {
    const res = await owner('get');
    const ids = (res.body.data as { company_id: string }[]).map((r) => r.company_id);
    expect(ids).not.toContain(COMPANY_A);
    expect(ids).not.toContain(COMPANY_B);
    // An existing, active company cannot be "approved" or "rejected" either.
    expect((await owner('post', `/${COMPANY_A}/reject`)).status).toBe(409);
  });
  it('never loses a sign-up when the owner email fails', async () => {
    failMail = true;
    const res = await post('register', registration('mailfail@new.test'));
    expect(res.status).toBe(201);
    const company = await companyOf('mailfail@new.test');
    expect(company.status).toBe('pending_approval');
    expect(messages).toHaveLength(0);
    // …and approving still works without mail.
    expect((await owner('post', `/${company.id}/approve`)).status).toBe(200);
    expect((await login('mailfail@new.test')).status).toBe(200);
  });
  it('rolls back company and user after a forced failure following the first writes', async () => {
    const before = await inspect<{ n: number }>('SELECT count(*)::int AS n FROM companies');
    vi.spyOn(app.get(AuditDispatcher), 'record').mockRejectedValueOnce(
      new Error('forced registration failure'),
    );
    expect((await post('register', registration('rollback@new.test'))).status).toBe(500);
    const after = await inspect<{ n: number }>('SELECT count(*)::int AS n FROM companies');
    expect(after.rows).toEqual(before.rows);
    expect((await inspect("SELECT * FROM users WHERE email='rollback@new.test'")).rows).toEqual([]);
    expect(messages).toHaveLength(0);
  });
  it.each([
    ['email', 'no-email'],
    ['password', 'short'],
    ['password', 'password123'],
    ['admin_name', ''],
    ['company_name', ''],
    ['employee_count_range', 'unlimited'],
    ['phone', 'bad'],
    ['company_id', COMPANY_B],
    ['role_id', 'admin'],
    ['website', 'bot'],
  ])('rejects invalid registration %s', async (field, value) => {
    expect(
      (await post('register', { ...registration('invalid@new.test'), [field]: value })).status,
    ).toBe(422);
    expect(messages).toHaveLength(0);
  });
  it('accepts the existing ten-character minimum and 200-character maximum', async () => {
    expect(
      (await post('register', { ...registration('minimum@new.test'), password: 'rare-pass!' }))
        .status,
    ).toBe(201);
    const password = 'an-uncommon-long-passphrase-'.repeat(8).slice(0, 200);
    expect((await post('register', { ...registration('maximum@new.test'), password })).status).toBe(
      201,
    );
    expect(
      (await post('register', { ...registration('too-long@new.test'), password: password + 'x' }))
        .status,
    ).toBe(422);
  });
  it('sends the approval email in the language the visitor registered in', async () => {
    expect(
      (await post('register', registration('english@new.test')).set('Accept-Language', 'en'))
        .status,
    ).toBe(201);
    const company = await companyOf('english@new.test');
    expect((await owner('post', `/${company.id}/approve`)).status).toBe(200);
    const approval = messages.find((m) => m.to === 'english@new.test');
    expect(approval?.html).toContain('lang="en"');
    expect(approval?.text).toContain('http://localhost:3000/en/login');
  });
  it('escapes visitor-supplied text in the owner email', async () => {
    expect(
      (
        await post('register', {
          ...registration('escape@new.test'),
          company_name: 'Tom & Jerry "Ltd"',
        })
      ).status,
    ).toBe(201);
    expect(messages[0]?.html).toContain('Tom &amp; Jerry &quot;Ltd&quot;');
  });
  it('enforces registration throttle independently of contact', async () => {
    for (let i = 0; i < 5; i++)
      await post('register', { ...registration(), password: 'password123' });
    expect((await post('register', registration('limited@new.test'))).status).toBe(429);
    expect((await post('contact', contact())).status).toBe(200);
  });
  it('does not expose protected endpoints to public visitors', async () => {
    for (const path of ['/auth/me', '/company', '/employees', '/notifications'])
      expect((await request(app.getHttpServer()).get(`/api/v1${path}`)).status).toBe(401);
  });
});

if (process.env.PHASE16_PREVIEW === '1')
  it('local browser preview fixture', async () => {
    // Explicitly opted-in, loopback-only, disposable PostgreSQL and fake mail.
    // No production connection, no background jobs, no token logged.
    await post('register', registration('browser-fixture@ufuq.test'));
    const company = await companyOf('browser-fixture@ufuq.test');
    await owner('post', `/${company.id}/approve`);
    redis.reset();
    writeFileSync('/private/tmp/ufuq-phase16-preview-ready', 'ready');
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (existsSync('/private/tmp/ufuq-phase16-preview-done')) {
          clearInterval(timer);
          resolve();
        }
      }, 1000);
    });
  }, 1200000);
