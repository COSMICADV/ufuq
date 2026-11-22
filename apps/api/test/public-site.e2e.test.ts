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
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import { AuditDispatcher } from '../src/auth/audit-dispatcher.js';
import { PersonalHealthService } from '../src/personal-health/health.service.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage } from '../src/mail/mail-transport.js';

import { AppModule } from '../src/app.module.js';
import { API_PREFIX } from '../src/api-prefix.js';
import type { AppInfo } from '../src/app.tokens.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { SAMPLES } from './attachment-samples.js';
import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
import { allMigrationsSql } from './all-migrations.js';

// Every migration, not only Phase 3's: the application under test reads the
// tables later phases add (see `migrations.ts`).
const MIGRATIONS_SQL = allMigrationsSql();

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let redis: FakeRedis;
const storage = new InMemoryObjectStorage();

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
    google: {
      clientId: 'google-client-test',
      clientSecret: 'google-secret-test',
      redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
    },
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
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
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

describe('1to1OS Personal — individual sign-up', () => {
  const personal = (email = 'person@personal.test'): Record<string, unknown> => ({
    name: 'سارة',
    email,
    password: 'a-safe-personal-passphrase',
    started_at: Date.now() - 3000,
    website: '',
  });

  it('opens an active one-person account that signs in at once, with no Business access', async () => {
    const res = await post('register-personal', personal());
    expect(res.status).toBe(201);
    expect(res.text).not.toMatch(/password|token|company_id/);
    const company = await companyOf('person@personal.test');
    expect(company.status).toBe('active');
    const kind = await inspect<{ kind: string; reviewed_at: string | null }>(
      'SELECT kind::text AS kind, reviewed_at FROM companies WHERE id=$1',
      [company.id],
    );
    expect(kind.rows[0]).toEqual({ kind: 'personal', reviewed_at: null });
    const audit = await inspect<{ action: string }>(
      'SELECT action::text AS action FROM audit_logs WHERE company_id=$1',
      [company.id],
    );
    expect(audit.rows.map((r) => r.action)).toContain('signup.personal');
    // No owner review, so no email and no entry on the owner's list.
    expect(messages).toHaveLength(0);
    const list = await owner('get');
    expect(
      (list.body.data as { company_id: string }[]).some((r) => r.company_id === company.id),
    ).toBe(false);

    const agent = request.agent(app.getHttpServer());
    const signedIn = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'person@personal.test', password: personal().password });
    expect(signedIn.status).toBe(200);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.body.data.role.key).toBe('personal');
    expect(me.body.data.permissions).toEqual([
      { key: 'personal.finance', scope: 'self' },
      { key: 'personal.health', scope: 'self' },
      { key: 'personal.car', scope: 'self' },
    ]);
    expect(me.body.data.employee).toBeNull();
    for (const path of ['/employees', '/attendance', '/payroll/periods'])
      expect((await agent.get(`/api/v1${path}`)).status).toBe(403);
  });

  it('refuses an email already used by any account, and a weak password', async () => {
    expect((await post('register-personal', personal('admin-a@company-a.test'))).status).toBe(409);
    expect((await post('register-personal', personal('p2@personal.test'))).status).toBe(201);
    expect((await post('register-personal', personal('p2@personal.test'))).status).toBe(409);
    const weak = await post('register-personal', {
      ...personal('p3@personal.test'),
      password: 'short',
    });
    expect(weak.status).toBe(422);
  });

  it('validates fields, refuses tenant input and is throttled on its own', async () => {
    expect((await post('register-personal', { ...personal(), name: '' })).status).toBe(422);
    expect(
      (
        await post('register-personal', {
          ...personal('x@personal.test'),
          company_id: COMPANY_A,
        })
      ).status,
    ).toBe(422);
    // 20 an hour: Personal sign-up is instant, and a typo counts too.
    for (let i = 0; i < 20; i++)
      await post('register-personal', {
        ...personal(`t${String(i)}@p.test`),
        password: 'short',
      });
    expect((await post('register-personal', personal('late@p.test'))).status).toBe(429);
    expect((await post('register', registration('still-open@new.test'))).status).toBe(201);
  });
});

describe('Continue with Google — Personal and Business', () => {
  const idToken = (claims: Record<string, unknown>): string =>
    `h.${Buffer.from(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: 'google-client-test',
        exp: Math.floor(Date.now() / 1000) + 300,
        sub: 'g-1',
        email_verified: true,
        name: 'Google Person',
        ...claims,
      }),
    ).toString('base64url')}.sig`;

  /** Runs start → (Google) → callback; Google's token endpoint answers `claims`. */
  async function googleRoundTrip(
    intent: 'personal' | 'signin',
    claims: Record<string, unknown>,
    tamper: (state: string) => string = (s) => s,
  ): Promise<{ location: string; cookies: string[] }> {
    const start = await request(app.getHttpServer()).get(
      `/api/v1/auth/google/start?intent=${intent}&locale=fr`,
    );
    expect(start.status).toBe(302);
    const google = new URL(start.headers.location as string);
    expect(google.host).toBe('accounts.google.com');
    const cookie = (start.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] ?? '';
    expect(cookie).toMatch(/^ufuq_google_oauth=/);
    const nonce = google.searchParams.get('nonce');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://oauth2.googleapis.com/token');
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('code')).toBe('code-1');
      expect(body.get('client_secret')).toBe('google-secret-test');
      expect(body.get('code_verifier')).toBeTruthy();
      return new Response(JSON.stringify({ id_token: idToken({ nonce, ...claims }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const back = await request(app.getHttpServer())
      .get(
        `/api/v1/auth/google/callback?code=code-1&state=${tamper(google.searchParams.get('state') ?? '')}`,
      )
      .set('Cookie', cookie);
    fetchSpy.mockRestore();
    expect(back.status).toBe(302);
    return {
      location: back.headers.location as string,
      cookies: (back.headers['set-cookie'] as unknown as string[] | undefined) ?? [],
    };
  }

  it('says whether Google is switched on', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/providers');
    expect(res.body.data).toEqual({ google: true });
  });

  it('creates an active Personal account for a new email from Personal sign-up and signs in', async () => {
    const res = await googleRoundTrip('personal', { email: 'New.Google@Gmail.com' });
    expect(res.location).toBe('http://localhost:3000/fr/personal');
    expect(res.cookies.some((c) => c.startsWith('ufuq_session='))).toBe(true);
    const company = await companyOf('new.google@gmail.com');
    expect(company.status).toBe('active');
    const user = await inspect<{ password_hash: string | null; display_name: string }>(
      "SELECT password_hash, display_name FROM users WHERE email='new.google@gmail.com'",
    );
    expect(user.rows[0]).toEqual({ password_hash: null, display_name: 'Google Person' });
    // The same Google account again simply signs in.
    expect((await googleRoundTrip('signin', { email: 'new.google@gmail.com' })).location).toBe(
      'http://localhost:3000/fr/personal',
    );
  });

  it('signs an existing Business account in, and never creates one from the sign-in page', async () => {
    const admin = await googleRoundTrip('signin', { email: ADMIN_A_EMAIL });
    expect(admin.location).toBe('http://localhost:3000/fr/admin/settings/company');
    expect(admin.cookies.some((c) => c.startsWith('ufuq_session='))).toBe(true);
    const unknown = await googleRoundTrip('signin', { email: 'stranger@gmail.com' });
    expect(unknown.location).toBe('http://localhost:3000/fr/login?oauth=no_account');
    expect(unknown.cookies.some((c) => c.startsWith('ufuq_session='))).toBe(false);
    const rows = await inspect("SELECT 1 FROM users WHERE email='stranger@gmail.com'");
    expect(rows.rows).toHaveLength(0);
  });

  it('applies the same status rules as a password sign-in', async () => {
    await post('register', registration('waiting@new-company.test'));
    const pending = await googleRoundTrip('signin', { email: 'waiting@new-company.test' });
    expect(pending.location).toBe('http://localhost:3000/fr/login?oauth=pending');
  });

  it('refuses a mismatched state, an unverified email and a cancelled consent', async () => {
    const forged = await googleRoundTrip('personal', { email: 'x1@gmail.com' }, (s) => `${s}x`);
    expect(forged.location).toBe('http://localhost:3000/fr/personal/start?oauth=expired');
    const unverified = await googleRoundTrip('personal', {
      email: 'x2@gmail.com',
      email_verified: false,
    });
    expect(unverified.location).toBe('http://localhost:3000/fr/personal/start?oauth=unverified');
    const noCookie = await request(app.getHttpServer()).get(
      '/api/v1/auth/google/callback?code=c&state=s',
    );
    expect(noCookie.headers.location).toBe('http://localhost:3000/ar/login?oauth=expired');
    const cancelled = await request(app.getHttpServer()).get(
      '/api/v1/auth/google/callback?error=access_denied',
    );
    expect(cancelled.headers.location).toBe('http://localhost:3000/ar/login?oauth=cancelled');
    const rows = await inspect(
      "SELECT 1 FROM users WHERE email IN ('x1@gmail.com','x2@gmail.com')",
    );
    expect(rows.rows).toHaveLength(0);
  });
});

describe('Forgot password — the reset link is emailed', () => {
  it('emails a one-time link in the account language and the new password signs in', async () => {
    expect(
      (
        await post('register-personal', {
          name: 'Reset Person',
          email: 'reset.person@personal.test',
          password: 'the-first-passphrase',
          started_at: Date.now() - 3000,
          website: '',
        })
      ).status,
    ).toBe(201);
    messages.length = 0;
    const asked = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .set('Accept-Language', 'fr')
      .send({ email: 'reset.person@personal.test' });
    expect(asked.status).toBeLessThan(300);
    expect(messages).toHaveLength(1);
    const mail = messages[0];
    expect(mail?.to).toBe('reset.person@personal.test');
    const link = /https?:\/\/\S+\/reset-password#token=(\S+)/.exec(mail?.text ?? '');
    expect(link).not.toBeNull();
    const token = decodeURIComponent(link?.[1] ?? '');
    expect(asked.text).not.toContain(token);

    const reset = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'a-brand-new-passphrase' });
    expect(reset.status).toBeLessThan(300);
    const again = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'another-passphrase-123' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    const signedIn = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'reset.person@personal.test', password: 'a-brand-new-passphrase' });
    expect(signedIn.status).toBe(200);
  });

  it('sends nothing, and says the same, for an unknown email', async () => {
    messages.length = 0;
    const asked = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@nowhere.test' });
    expect(asked.status).toBeLessThan(300);
    expect(messages).toHaveLength(0);
  });
});

describe('1to1OS Personal — Expenses', () => {
  interface CsrfAgent {
    get: (url: string) => request.Test;
    post: (url: string) => request.Test;
    patch: (url: string) => request.Test;
    delete: (url: string) => request.Test;
  }
  /** A signed-in browser: writes carry the double-submit CSRF header, as the web does. */
  function withCsrf(agent: ReturnType<typeof request.agent>, cookies: string[]): CsrfAgent {
    const csrf = cookies.map((c) => /ufuq_csrf=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? '';
    return {
      get: (url) => agent.get(url),
      post: (url) => agent.post(url).set('X-CSRF-Token', csrf),
      patch: (url) => agent.patch(url).set('X-CSRF-Token', csrf),
      delete: (url) => agent.delete(url).set('X-CSRF-Token', csrf),
    };
  }
  async function personalAgent(email: string): Promise<CsrfAgent> {
    expect(
      (
        await post('register-personal', {
          name: 'Finance Person',
          email,
          password: 'finance-passphrase-1',
          started_at: Date.now() - 3000,
          website: '',
        })
      ).status,
    ).toBe(201);
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email, password: 'finance-passphrase-1' });
    expect(login.status).toBe(200);
    return withCsrf(agent, login.headers['set-cookie'] as unknown as string[]);
  }
  const F = '/api/v1/personal/finance';

  it('starts with the default categories and a cash wallet in EGP', async () => {
    const agent = await personalAgent('fin.defaults@personal.test');
    const categories = await agent.get(`${F}/categories`).set('Accept-Language', 'ar');
    expect(categories.status).toBe(200);
    const keys = (categories.body.data as { key: string | null; kind: string }[])
      .filter((c) => c.kind === 'expense')
      .map((c) => c.key);
    expect(keys).toEqual([
      'food',
      'groceries',
      'transport',
      'fuel',
      'car_maintenance',
      'home',
      'bills',
      'health',
      'shopping',
      'education',
      'entertainment',
      'subscriptions',
      'other',
    ]);
    const accounts = await agent.get(`${F}/accounts`).set('Accept-Language', 'ar');
    expect(accounts.body.data).toMatchObject([
      { name: 'محفظة الكاش', type: 'cash', currency: 'EGP', balance: '0.00' },
    ]);
    // Opening Expenses again does not duplicate anything.
    expect((await agent.get(`${F}/categories`)).body.data).toHaveLength(
      categories.body.data.length,
    );
    expect((await agent.get(`${F}/accounts`)).body.data).toHaveLength(1);
  });

  it('keeps balances exact: income, expense, transfer and a credit card are each counted once', async () => {
    const agent = await personalAgent('fin.balances@personal.test');
    const cats = (await agent.get(`${F}/categories`)).body.data as { id: string; key: string }[];
    const food = cats.find((c) => c.key === 'food')?.id;
    const salary = cats.find((c) => c.key === 'salary')?.id;
    const bank = (
      await agent
        .post(`${F}/accounts`)
        .send({ name: 'CIB', type: 'bank', opening_balance: '1000.10' })
    ).body.data;
    const card = (
      await agent.post(`${F}/accounts`).send({ name: 'Visa', type: 'credit_card', owed: '200' })
    ).body.data;
    expect(card.balance).toBe('-200.00');
    const savings = (await agent.post(`${F}/accounts`).send({ name: 'Savings', type: 'savings' }))
      .body.data;
    const at = '2026-11-20T10:00:00.000Z';
    const tx = async (body: Record<string, unknown>) => {
      const res = await agent.post(`${F}/transactions`).send({ occurred_at: at, ...body });
      expect(res.status).toBe(201);
      return res.body.data;
    };
    await tx({ type: 'income', amount: '15000', account_id: bank.id, category_id: salary });
    await tx({
      type: 'expense',
      amount: '0.10',
      account_id: bank.id,
      category_id: food,
      merchant: 'Bakery',
    });
    await tx({ type: 'expense', amount: '350.25', account_id: card.id, category_id: food });
    // Paying the card and saving are transfers, not expenses.
    await tx({ type: 'transfer', amount: '550.25', account_id: bank.id, to_account_id: card.id });
    await tx({ type: 'transfer', amount: '2000', account_id: bank.id, to_account_id: savings.id });

    const byName = Object.fromEntries(
      ((await agent.get(`${F}/accounts`)).body.data as { name: string; balance: string }[]).map(
        (a) => [a.name, a.balance],
      ),
    );
    expect(byName).toMatchObject({ CIB: '13449.75', Visa: '0.00', Savings: '2000.00' });

    const summary = (await agent.get(`${F}/summary?period=custom&from=2026-11-01&to=2026-11-30`))
      .body.data;
    expect(summary.income).toBe('15000.00');
    expect(summary.expense).toBe('350.35');
    expect(summary.net).toBe('14649.65');
    // Cash 0 + bank 13449.75 + savings 2000 (the card is not cash you hold).
    expect(summary.available).toEqual([{ currency: 'EGP', amount: '15449.75' }]);
    expect(summary.credit_owed).toEqual([]);
    expect(summary.by_category).toMatchObject([{ key: 'food', amount: '350.35' }]);
  });

  it('refuses malformed and mismatched transactions', async () => {
    const agent = await personalAgent('fin.rules@personal.test');
    const cats = (await agent.get(`${F}/categories`)).body.data as { id: string; key: string }[];
    const salary = cats.find((c) => c.key === 'salary')?.id;
    const cash = ((await agent.get(`${F}/accounts`)).body.data as { id: string }[])[0]?.id;
    const usd = (
      await agent.post(`${F}/accounts`).send({ name: 'USD', type: 'bank', currency: 'USD' })
    ).body.data;
    const at = '2026-11-20T10:00:00.000Z';
    const bad = async (body: Record<string, unknown>, field: string) => {
      const res = await agent.post(`${F}/transactions`).send({ occurred_at: at, ...body });
      expect(res.status).toBe(422);
      expect(Object.keys(res.body.error.fields ?? {})).toContain(field);
    };
    await bad({ type: 'expense', amount: '0', account_id: cash }, 'amount');
    await bad({ type: 'expense', amount: '1.005', account_id: cash }, 'amount');
    await bad(
      { type: 'expense', amount: '10', account_id: cash, category_id: salary },
      'category_id',
    );
    await bad({ type: 'transfer', amount: '10', account_id: cash }, 'to_account_id');
    await bad(
      { type: 'transfer', amount: '10', account_id: cash, to_account_id: cash },
      'to_account_id',
    );
    await bad(
      { type: 'transfer', amount: '10', account_id: cash, to_account_id: usd.id },
      'to_account_id',
    );
    await bad(
      { type: 'expense', amount: '10', account_id: cash, company_id: COMPANY_A },
      'company_id',
    );
  });

  it('archives a used account instead of losing its history, and edits and deletes transactions', async () => {
    const agent = await personalAgent('fin.edit@personal.test');
    const cash = ((await agent.get(`${F}/accounts`)).body.data as { id: string }[])[0]?.id;
    const created = (
      await agent.post(`${F}/transactions`).send({
        type: 'income',
        amount: '100',
        account_id: cash,
        occurred_at: '2026-11-20T10:00:00.000Z',
      })
    ).body.data;
    const edited = await agent
      .patch(`${F}/transactions/${String(created.id)}`)
      .send({ amount: '120.50' });
    expect(edited.body.data.amount).toBe('120.50');
    expect((await agent.delete(`${F}/accounts/${String(cash)}`)).body.data).toEqual({
      archived: true,
    });
    expect(
      ((await agent.get(`${F}/accounts`)).body.data as { balance: string }[])[0]?.balance,
    ).toBe('120.50');
    expect((await agent.delete(`${F}/transactions/${String(created.id)}`)).status).toBe(204);
    const list = await agent.get(`${F}/transactions`);
    expect(list.body.data).toEqual([]);
    // With no transactions left, the account is unused and is deleted outright.
    expect((await agent.delete(`${F}/accounts/${String(cash)}`)).body.data).toEqual({
      archived: false,
    });
    expect((await agent.get(`${F}/transactions`)).body.data).toEqual([]);
  });

  it('keeps every Personal account to its own money, and Business accounts out', async () => {
    const owner = await personalAgent('fin.owner@personal.test');
    const cash = ((await owner.get(`${F}/accounts`)).body.data as { id: string }[])[0]?.id;
    const tx = (
      await owner.post(`${F}/transactions`).send({
        type: 'income',
        amount: '5',
        account_id: cash,
        occurred_at: '2026-11-20T10:00:00.000Z',
      })
    ).body.data;
    const stranger = await personalAgent('fin.stranger@personal.test');
    expect((await stranger.get(`${F}/transactions/${String(tx.id)}`)).status).toBe(404);
    expect(
      (await stranger.patch(`${F}/transactions/${String(tx.id)}`).send({ amount: '1' })).status,
    ).toBe(404);
    expect((await stranger.delete(`${F}/transactions/${String(tx.id)}`)).status).toBe(404);
    expect((await stranger.get(`${F}/transactions`)).body.data).toEqual([]);
    const own = (await stranger.get(`${F}/accounts`)).body.data as { id: string }[];
    const write = await stranger.post(`${F}/transactions`).send({
      type: 'expense',
      amount: '1',
      account_id: cash,
      occurred_at: '2026-11-20T10:00:00.000Z',
    });
    expect(write.status).toBe(422);
    expect(own.map((a) => a.id)).not.toContain(cash);

    const business = request.agent(app.getHttpServer());
    expect(
      (
        await business
          .post('/api/v1/auth/login')
          .send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD })
      ).status,
    ).toBe(200);
    expect((await business.get(`${F}/summary`)).status).toBe(403);
    expect((await business.get(`${F}/accounts`)).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`${F}/summary`)).status).toBe(401);
  });

  it('keeps receipts private to the transaction, counts them, and retires them with it', async () => {
    const owner = await personalAgent('fin.receipts@personal.test');
    const cash = ((await owner.get(`${F}/accounts`)).body.data as { id: string }[])[0]?.id;
    const created = await owner.post(`${F}/transactions`).send({
      type: 'expense',
      amount: '120.50',
      account_id: cash,
      occurred_at: '2026-11-20T10:00:00.000Z',
      merchant: 'Seoudi',
    });
    expect(created.status).toBe(201);
    const id = String(created.body.data.id);
    expect(created.body.data.receipt_count).toBe(0);

    const upload = (bytes: Buffer, name: string, type: string) =>
      owner
        .post('/api/v1/attachments')
        .field('related_type', 'finance_transaction')
        .field('related_id', id)
        .attach('file', bytes, { filename: name, contentType: type });
    const first = await upload(SAMPLES.png.bytes, 'receipt-1.png', 'image/png');
    expect(first.status).toBe(201);
    expect((await upload(SAMPLES.pdf.bytes, 'receipt-2.pdf', 'application/pdf')).status).toBe(201);
    // A PDF dressed as an image is still refused by the shared byte check.
    expect((await upload(SAMPLES.pdf.bytes, 'fake.png', 'image/png')).status).toBe(422);

    const one = await owner.get(`${F}/transactions/${id}`);
    expect(one.body.data.receipt_count).toBe(2);
    expect((one.body.data.receipts as { original_name: string }[]).map((r) => r.original_name).sort()).toEqual([
      'receipt-1.png',
      'receipt-2.pdf',
    ]);
    const listed = (await owner.get(`${F}/transactions`)).body.data as { id: string; receipt_count: number }[];
    expect(listed.find((t) => t.id === id)?.receipt_count).toBe(2);
    const fileId = String(first.body.data.id);
    const download = await owner.get(`/api/v1/attachments/${fileId}`);
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toBe('private, no-store');

    // Nobody else sees it: another Personal account, a Business admin, or no one signed in.
    const stranger = await personalAgent('fin.receipts.stranger@personal.test');
    expect((await stranger.get(`/api/v1/attachments/${fileId}`)).status).toBe(404);
    expect(
      (
        await stranger
          .post('/api/v1/attachments')
          .field('related_type', 'finance_transaction')
          .field('related_id', id)
          .attach('file', SAMPLES.png.bytes, { filename: 'x.png', contentType: 'image/png' })
      ).status,
    ).toBe(404);
    const business = request.agent(app.getHttpServer());
    await business.post('/api/v1/auth/login').send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
    expect((await business.get(`/api/v1/attachments/${fileId}`)).status).toBe(404);
    expect((await request(app.getHttpServer()).get(`/api/v1/attachments/${fileId}`)).status).toBe(401);

    // Removing one receipt, then the transaction itself, retires the files.
    expect((await owner.delete(`/api/v1/attachments/${fileId}`)).status).toBe(204);
    expect((await owner.get(`${F}/transactions/${id}`)).body.data.receipt_count).toBe(1);
    expect((await owner.delete(`${F}/transactions/${id}`)).status).toBe(204);
    const second = String((one.body.data.receipts as { id: string; original_name: string }[]).find((r) => r.original_name === 'receipt-2.pdf')?.id);
    expect((await owner.get(`/api/v1/attachments/${second}`)).status).toBe(404);
  });
  describe('budgets', () => {
    const B = `${F}/budgets`;
    it('measures budgets from the stored expenses: scope, rollover, alerts and other currencies', async () => {
      const owner = await personalAgent('fin.budgets@personal.test');
      const accounts = (await owner.get(`${F}/accounts`)).body.data as { id: string }[];
      const cash = String(accounts[0]?.id);
      const bank = String(
        (await owner.post(`${F}/accounts`).send({ name: 'CIB', type: 'bank', opening_balance: '5000' })).body.data.id,
      );
      const usd = String(
        (await owner.post(`${F}/accounts`).send({ name: 'USD', type: 'bank', currency: 'USD' })).body.data.id,
      );
      const categories = (await owner.get(`${F}/categories`)).body.data as { id: string; key: string | null; kind: string }[];
      const cat = (key: string) => String(categories.find((c) => c.key === key)?.id);
      const octane = String(
        (await owner.post(`${F}/categories`).send({ kind: 'expense', name: 'Octane 95', parent_id: cat('fuel') })).body
          .data.id,
      );
      const add = async (body: Record<string, unknown>) => {
        const r = await owner.post(`${F}/transactions`).send(body);
        expect(r.status).toBe(201);
      };
      await add({ type: 'expense', amount: '900', account_id: cash, category_id: cat('fuel'), occurred_at: '2026-10-15T10:00:00.000Z' });
      await add({ type: 'expense', amount: '300', account_id: cash, category_id: cat('fuel'), occurred_at: '2026-11-05T10:00:00.000Z' });
      await add({ type: 'expense', amount: '250', account_id: bank, category_id: octane, occurred_at: '2026-11-06T10:00:00.000Z' });
      await add({ type: 'expense', amount: '100', account_id: bank, category_id: cat('groceries'), occurred_at: '2026-11-07T10:00:00.000Z' });
      await add({ type: 'transfer', amount: '50', account_id: bank, to_account_id: cash, occurred_at: '2026-11-08T10:00:00.000Z' });
      await add({ type: 'income', amount: '1000', account_id: bank, occurred_at: '2026-11-09T10:00:00.000Z' });
      await add({ type: 'expense', amount: '40', account_id: usd, category_id: cat('fuel'), occurred_at: '2026-11-10T10:00:00.000Z' });
      // Midnight in Cairo on 1 December belongs to December, not November.
      await add({ type: 'expense', amount: '999', account_id: cash, category_id: cat('groceries'), occurred_at: '2026-11-30T22:30:00.000Z' });

      const fuel = await owner.post(B).send({
        period: 'monthly',
        category_id: cat('fuel'),
        amount: '1000',
        start_month: '2026-10',
        rollover: true,
      });
      expect(fuel.status).toBe(201);
      expect(
        (await owner.post(B).send({ period: 'monthly', amount: '600', start_month: '2026-11' })).status,
      ).toBe(201);
      expect(
        (
          await owner.post(B).send({
            period: 'custom',
            name: 'November groceries',
            category_id: cat('groceries'),
            amount: '120',
            start_date: '2026-11-01',
            end_date: '2026-11-30',
            alert_thresholds: [80],
          })
        ).status,
      ).toBe(201);

      const list = await owner.get(`${B}?month=2026-11`);
      expect(list.status).toBe(200);
      const budgets = list.body.data.budgets as {
        id: string;
        name: string | null;
        category_key: string | null;
        current: Record<string, unknown> | null;
      }[];
      // Sorted by how much is used: overall 108%, groceries 83%, fuel 50%.
      expect(budgets.map((b) => b.category_key ?? b.name)).toEqual([null, 'groceries', 'fuel']);
      expect(budgets[0]?.current).toMatchObject({ spent: '650.00', limit: '600.00', remaining: '-50.00', percent: 108, level: 100, state: 'over' });
      expect(budgets[1]?.current).toMatchObject({ spent: '100.00', percent: 83, level: 80, state: 'warning', from: '2026-11-01', to: '2026-11-30' });
      expect(budgets[2]?.current).toMatchObject({ month: '2026-11', carried: '100.00', limit: '1100.00', spent: '550.00', remaining: '550.00', percent: 50, level: null, state: 'ok' });

      const history = await owner.get(`${B}/${String(fuel.body.data.id)}/history`);
      expect((history.body.data as { month: string; spent: string }[]).slice(-2).map((h) => [h.month, h.spent])).toEqual([
        ['2026-11', '550.00'],
        ['2026-10', '900.00'],
      ]);
      // October, before the overall budget started, shows only the fuel budget running.
      const october = (await owner.get(`${B}?month=2026-10`)).body.data.budgets as { current: unknown }[];
      expect(october.filter((b) => b.current !== null)).toHaveLength(1);
    });

    it('refuses duplicates and nonsense, archives and restores, and keeps a budgeted category', async () => {
      const owner = await personalAgent('fin.budgets.rules@personal.test');
      const categories = (await owner.get(`${F}/categories`)).body.data as { id: string; key: string | null }[];
      const cat = (key: string) => String(categories.find((c) => c.key === key)?.id);
      const first = await owner.post(B).send({ period: 'monthly', category_id: cat('home'), amount: '2000' });
      expect(first.status).toBe(201);
      const id = String(first.body.data.id);
      const again = await owner.post(B).send({ period: 'monthly', category_id: cat('home'), amount: '50' });
      expect(again.status).toBe(422);
      expect(again.body.error.fields.category_id).toEqual(['already_taken']);
      expect((await owner.post(B).send({ period: 'monthly', category_id: cat('salary'), amount: '5' })).status).toBe(422);
      expect((await owner.post(B).send({ period: 'custom', amount: '5', start_date: '2026-11-01' })).status).toBe(422);
      expect(
        (await owner.post(B).send({ period: 'custom', amount: '5', start_date: '2026-11-10', end_date: '2026-11-01' })).status,
      ).toBe(422);
      expect((await owner.post(B).send({ period: 'monthly', amount: '0' })).status).toBe(422);
      expect((await owner.post(B).send({ period: 'monthly', amount: '5', alert_thresholds: [33] })).status).toBe(422);

      const edited = await owner.patch(`${B}/${id}`).send({ amount: '2500', alert_thresholds: [100, 90, 90], rollover: true });
      expect(edited.body.data).toMatchObject({ amount: '2500.00', alert_thresholds: [90, 100], rollover: true });
      expect((await owner.patch(`${B}/${id}`).send({ end_date: '2026-12-01' })).status).toBe(422);

      expect((await owner.delete(`${B}/${id}`)).status).toBe(204);
      expect(((await owner.get(B)).body.data.budgets as unknown[]).length).toBe(0);
      expect(((await owner.get(`${B}?include_archived=true`)).body.data.budgets as { archived: boolean }[])[0]?.archived).toBe(true);
      // While it is archived another home budget may run; restoring then clashes.
      const replacement = await owner.post(B).send({ period: 'monthly', category_id: cat('home'), amount: '10' });
      expect(replacement.status).toBe(201);
      expect((await owner.post(`${B}/${id}/restore`)).status).toBe(422);
      expect((await owner.delete(`${B}/${String(replacement.body.data.id)}`)).status).toBe(204);
      expect((await owner.post(`${B}/${id}/restore`)).status).toBe(204);

      // A category a budget points at is archived, never deleted from under it.
      const mine = String((await owner.post(`${F}/categories`).send({ kind: 'expense', name: 'Gym' })).body.data.id);
      expect((await owner.post(B).send({ period: 'monthly', category_id: mine, amount: '300' })).status).toBe(201);
      expect((await owner.delete(`${F}/categories/${mine}`)).body.data.archived).toBe(true);

      const stranger = await personalAgent('fin.budgets.stranger@personal.test');
      expect((await stranger.get(`${B}/${id}`)).status).toBe(404);
      expect((await stranger.patch(`${B}/${id}`).send({ amount: '1' })).status).toBe(404);
      expect((await stranger.delete(`${B}/${id}`)).status).toBe(404);
      expect(((await stranger.get(B)).body.data.budgets as unknown[]).length).toBe(0);
      const business = request.agent(app.getHttpServer());
      await business.post('/api/v1/auth/login').send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
      expect((await business.get(B)).status).toBe(403);
      expect((await request(app.getHttpServer()).get(B)).status).toBe(401);
    });
  });
});

describe('1to1OS Personal — Health records', () => {
  const H = '/api/v1/personal/health';
  async function healthAgent(email: string) {
    expect(
      (
        await post('register-personal', {
          name: 'Health Person',
          email,
          password: 'health-passphrase-1',
          started_at: Date.now() - 3000,
          website: '',
        })
      ).status,
    ).toBe(201);
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password: 'health-passphrase-1' });
    expect(login.status).toBe(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const csrf = cookies.map((c) => /ufuq_csrf=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? '';
    return {
      get: (url: string) => agent.get(url),
      post: (url: string) => agent.post(url).set('X-CSRF-Token', csrf),
      patch: (url: string) => agent.patch(url).set('X-CSRF-Token', csrf),
      delete: (url: string) => agent.delete(url).set('X-CSRF-Token', csrf),
    };
  }
  type HealthAgent = Awaited<ReturnType<typeof healthAgent>>;
  const page = (agent: HealthAgent, id: string, bytes = SAMPLES.png.bytes, name = 'page-1.png', type = 'image/png') =>
    agent
      .post('/api/v1/attachments')
      .field('related_type', 'health_document')
      .field('related_id', id)
      .attach('file', bytes, { filename: name, contentType: type });

  it('stores a document with several pages, lists, searches and edits it', async () => {
    const me = await healthAgent('health.records@personal.test');
    const created = await me.post(`${H}/documents`).send({
      title: 'CBC blood test',
      category: 'lab_result',
      document_date: '2026-11-15',
      notes: 'Fasting',
    });
    expect(created.status).toBe(201);
    const id = String(created.body.data.id);
    expect((await page(me, id)).status).toBe(201);
    expect((await page(me, id, SAMPLES.pdf.bytes, 'page-2.pdf', 'application/pdf')).status).toBe(201);
    // The shared byte check still refuses a disguised file.
    expect((await page(me, id, SAMPLES.pdf.bytes, 'x.png', 'image/png')).status).toBe(422);

    const one = await me.get(`${H}/documents/${id}`);
    expect(one.body.data).toMatchObject({ title: 'CBC blood test', category: 'lab_result', document_date: '2026-11-15', page_count: 2, in_trash: false });
    expect((one.body.data.pages as { mime_type: string }[]).map((p) => p.mime_type)).toEqual(['image/png', 'application/pdf']);
    expect(one.body.data.cover_id).toBe((one.body.data.pages as { id: string }[])[0]?.id);

    await me.post(`${H}/documents`).send({ title: 'Glasses prescription', category: 'prescription' });
    const list = await me.get(`${H}/documents`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.data[0].title).toBe('CBC blood test'); // dated documents first
    expect((await me.get(`${H}/documents?category=prescription`)).body.data).toHaveLength(1);
    expect((await me.get(`${H}/documents?q=fasting`)).body.data).toHaveLength(1);

    const edited = await me.patch(`${H}/documents/${id}`).send({ title: 'CBC', document_date: '' });
    expect(edited.body.data).toMatchObject({ title: 'CBC', document_date: null, page_count: 2 });
    expect((await me.post(`${H}/documents`).send({ title: '', category: 'lab_result' })).status).toBe(422);
    expect((await me.post(`${H}/documents`).send({ title: 'x', category: 'horoscope' })).status).toBe(422);

    const overview = await me.get(`${H}/overview`);
    expect(overview.body.data).toMatchObject({ documents: 2, trash: 0 });
    expect(overview.body.data.by_category.lab_result).toBe(1);
  });

  it('keeps pages private, audits every view without the file name', async () => {
    const owner = await healthAgent('health.private@personal.test');
    const id = String((await owner.post(`${H}/documents`).send({ title: 'MRI report', category: 'imaging' })).body.data.id);
    const uploaded = await page(owner, id, SAMPLES.png.bytes, 'HIV result.png');
    const fileId = String(uploaded.body.data.id);
    const download = await owner.get(`/api/v1/attachments/${fileId}`);
    expect(download.status).toBe(200);
    expect(download.headers['cache-control']).toBe('private, no-store');

    const stranger = await healthAgent('health.stranger@personal.test');
    expect((await stranger.get(`${H}/documents/${id}`)).status).toBe(404);
    expect((await stranger.get(`/api/v1/attachments/${fileId}`)).status).toBe(404);
    expect((await page(stranger, id)).status).toBe(404);
    expect((await stranger.get(`${H}/documents`)).body.data).toEqual([]);
    const business = request.agent(app.getHttpServer());
    await business.post('/api/v1/auth/login').send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
    expect((await business.get(`${H}/overview`)).status).toBe(403);
    expect((await business.get(`/api/v1/attachments/${fileId}`)).status).toBe(404);
    expect((await request(app.getHttpServer()).get(`${H}/documents`)).status).toBe(401);

    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const companyId = (await owner.get('/api/v1/auth/me')).body.data.company.id as string;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const audits = await withTenant(prisma, companyId, (tx) =>
      tx.auditLog.findMany({ where: { entityId: fileId }, select: { action: true, newValues: true } }),
    );
    expect(audits.map((a) => a.action).sort()).toEqual(['ATTACHMENT_ACCESSED', 'ATTACHMENT_UPLOADED']);
    expect(JSON.stringify(audits)).not.toContain('HIV');
    expect(JSON.stringify(audits)).toContain('[sensitive]');
  });

  it('moves to the trash, restores, and removes for good — by hand or after 30 days', async () => {
    const me = await healthAgent('health.trash@personal.test');
    const a = String((await me.post(`${H}/documents`).send({ title: 'Old X-ray', category: 'imaging' })).body.data.id);
    const b = String((await me.post(`${H}/documents`).send({ title: 'Old prescription', category: 'prescription' })).body.data.id);
    const pageA = String((await page(me, a)).body.data.id);
    await page(me, b);
    const before = storage.objects.size;

    expect((await me.delete(`${H}/documents/${a}/permanent`)).status).toBe(422); // not in the trash yet
    expect((await me.delete(`${H}/documents/${a}`)).status).toBe(204);
    expect((await me.get(`${H}/documents`)).body.data).toHaveLength(0 + 1);
    const trash = await me.get(`${H}/documents?trash=true`);
    expect(trash.body.data[0]).toMatchObject({ id: a, in_trash: true, days_left: 30 });
    // In the trash: still viewable, but no new pages and no edits.
    expect((await me.get(`/api/v1/attachments/${pageA}`)).status).toBe(200);
    expect((await page(me, a)).status).toBe(403);
    expect((await me.patch(`${H}/documents/${a}`).send({ title: 'x' })).status).toBe(422);

    expect((await me.post(`${H}/documents/${a}/restore`)).status).toBe(204);
    expect((await me.get(`${H}/documents`)).body.data).toHaveLength(2);

    // Removed by hand: the row, and the stored bytes.
    expect((await me.delete(`${H}/documents/${a}`)).status).toBe(204);
    expect((await me.delete(`${H}/documents/${a}/permanent`)).status).toBe(204);
    expect((await me.get(`${H}/documents/${a}`)).status).toBe(404);
    expect((await me.get(`/api/v1/attachments/${pageA}`)).status).toBe(404);
    expect(storage.objects.size).toBe(before - 1);

    // Removed by the daily job once 30 days have passed.
    expect((await me.delete(`${H}/documents/${b}`)).status).toBe(204);
    const health = app.get(PersonalHealthService);
    expect(await health.purgeExpired(new Date(Date.now() + 29 * 86_400_000))).toBe(0);
    expect(await health.purgeExpired(new Date(Date.now() + 31 * 86_400_000))).toBeGreaterThanOrEqual(1);
    expect((await me.get(`${H}/documents?trash=true`)).body.data).toEqual([]);
    expect(storage.objects.size).toBe(before - 2);
  });
});

describe('1to1OS Personal — My Car odometer', () => {
  const C = '/api/v1/personal/car';
  async function carAgent(email: string) {
    expect(
      (await post('register-personal', { name: 'Car Person', email, password: 'car-passphrase-1', started_at: Date.now() - 3000, website: '' })).status,
    ).toBe(201);
    const agent = request.agent(app.getHttpServer());
    const login = await agent.post('/api/v1/auth/login').send({ email, password: 'car-passphrase-1' });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const csrf = cookies.map((c) => /ufuq_csrf=([^;]+)/.exec(c)?.[1]).find(Boolean) ?? '';
    return {
      get: (url: string) => agent.get(url),
      post: (url: string) => agent.post(url).set('X-CSRF-Token', csrf),
      patch: (url: string) => agent.patch(url).set('X-CSRF-Token', csrf),
      delete: (url: string) => agent.delete(url).set('X-CSRF-Token', csrf),
    };
  }
  const base = Date.now() - 60_000;
  const daysAgo = (n: number) => new Date(base - n * 86_400_000).toISOString();

  it('keeps readings in order, learns the average, and handles resets and corrections', async () => {
    const me = await carAgent('car.readings@personal.test');
    const created = await me.post(`${C}/vehicles`).send({ name: 'Corolla', make: 'Toyota', year: 2021, plate: 'س ق ر 123' });
    expect(created.status).toBe(201);
    const v = String(created.body.data.id);
    expect(created.body.data.stats).toMatchObject({ status: 'insufficient', reason: 'no_readings', current_km: null });
    expect((await me.post(`${C}/vehicles`).send({ name: 'Corolla' })).status).toBe(422);

    const add = (body: Record<string, unknown>) => me.post(`${C}/vehicles/${v}/readings`).send(body);
    expect((await add({ reading_km: 40_000, read_at: daysAgo(30), source: 'photo' })).status).toBe(201);
    expect((await add({ reading_km: 40_600, read_at: daysAgo(20) })).status).toBe(201);
    let stats = (await me.get(`${C}/vehicles/${v}`)).body.data.stats;
    expect(stats).toMatchObject({ status: 'insufficient', reason: 'need_readings' });

    // Below the previous reading: refused, with the reason.
    const lower = await add({ reading_km: 40_500, read_at: daysAgo(10) });
    expect(lower.status).toBe(422);
    expect(lower.body.error.fields.reading_km).toEqual(['decreasing']);
    // Above the next reading, when back-dated: refused.
    expect((await add({ reading_km: 40_700, read_at: daysAgo(25) })).body.error.fields.reading_km).toEqual(['exceeds_next']);
    // A huge jump needs confirming.
    const jump = await add({ reading_km: 90_000, read_at: daysAgo(10) });
    expect(jump.body.error.fields.reading_km).toEqual(['unusual']);
    // In the future: refused.
    expect((await add({ reading_km: 41_000, read_at: new Date(Date.now() + 86_400_000).toISOString() })).status).toBe(422);

    const third = await add({ reading_km: 41_500, read_at: daysAgo(0) });
    expect(third.status).toBe(201);
    expect(third.body.data.since_previous_km).toBe(900);
    const detail = (await me.get(`${C}/vehicles/${v}`)).body.data;
    // 1,500 km over 30 days = 50.0 km/day, 1,522 km a month.
    expect(detail.stats).toMatchObject({ status: 'ok', current_km: 41_500, daily_km: '50.0', monthly_km: 1522, readings_used: 3, span_days: 30 });
    expect(detail.readings.map((r: { reading_km: number }) => r.reading_km)).toEqual([41_500, 40_600, 40_000]);

    // A correction is re-checked and marked.
    const second = String(detail.readings[1].id);
    expect((await me.patch(`${C}/readings/${second}`).send({ reading_km: 42_000 })).body.error.fields.reading_km).toEqual(['exceeds_next']);
    const fixed = await me.patch(`${C}/readings/${second}`).send({ reading_km: 40_550 });
    expect(fixed.body.data).toMatchObject({ reading_km: 40_550, corrected: true });

    // A replaced odometer starts a new segment; averages restart there.
    expect((await add({ reading_km: 5, read_at: daysAgo(40), kind: 'replacement' })).body.error.fields.kind).toEqual(['reset_not_latest']);
    const swap = await add({ reading_km: 0, read_at: new Date().toISOString(), kind: 'replacement', note: 'cluster replaced' });
    expect(swap.status).toBe(201);
    expect(swap.body.data.segment).toBe(2);
    stats = (await me.get(`${C}/vehicles/${v}`)).body.data.stats;
    expect(stats).toMatchObject({ segment: 2, current_km: 0, status: 'insufficient', reason: 'need_readings' });
    // While a later reading exists, the reset cannot be removed; on its own, it can.
    expect((await me.delete(`${C}/readings/${String(swap.body.data.id)}`)).status).toBe(204);
    expect((await me.get(`${C}/vehicles/${v}`)).body.data.stats.segment).toBe(1);

    // A vehicle with history is archived, not lost.
    expect((await me.delete(`${C}/vehicles/${v}`)).body.data.archived).toBe(true);
    expect(((await me.get(`${C}/vehicles`)).body.data as unknown[]).length).toBe(0);
    expect((await add({ reading_km: 42_000, read_at: daysAgo(0) })).status).toBe(422);
    expect((await me.post(`${C}/vehicles/${v}/restore`)).status).toBe(204);
  });

  it('keeps photos and readings private to their account', async () => {
    const owner = await carAgent('car.owner@personal.test');
    const v = String((await owner.post(`${C}/vehicles`).send({ name: 'Car', current_km: 1000 })).body.data.id);
    const reading = String((await owner.get(`${C}/vehicles/${v}`)).body.data.readings[0].id);
    const photo = await owner
      .post('/api/v1/attachments')
      .field('related_type', 'odometer_reading')
      .field('related_id', reading)
      .attach('file', SAMPLES.png.bytes, { filename: 'odometer.png', contentType: 'image/png' });
    expect(photo.status).toBe(201);
    expect((await owner.get(`${C}/vehicles/${v}`)).body.data.readings[0].photo_ids).toEqual([photo.body.data.id]);

    const stranger = await carAgent('car.stranger@personal.test');
    expect((await stranger.get(`${C}/vehicles/${v}`)).status).toBe(404);
    expect((await stranger.post(`${C}/vehicles/${v}/readings`).send({ reading_km: 2000, read_at: daysAgo(0) })).status).toBe(404);
    expect((await stranger.get(`/api/v1/attachments/${String(photo.body.data.id)}`)).status).toBe(404);
    const business = request.agent(app.getHttpServer());
    await business.post('/api/v1/auth/login').send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
    expect((await business.get(`${C}/vehicles`)).status).toBe(403);
    expect((await request(app.getHttpServer()).get(`${C}/vehicles`)).status).toBe(401);

    // Removing a reading retires its photo.
    expect((await owner.delete(`${C}/readings/${reading}`)).status).toBe(204);
    expect((await owner.get(`/api/v1/attachments/${String(photo.body.data.id)}`)).status).toBe(404);
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
