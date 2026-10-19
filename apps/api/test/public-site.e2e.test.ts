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
import { InvitationService } from '../src/auth/invitation.service.js';
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
      from: 'Ufuq <no-reply@ufuq.test>',
      contactTo: 'contact@ufuq.test',
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

describe('Phase 16 registration and auth integration', () => {
  it('creates company + first ADMIN + invitation atomically, verifies and signs in through existing auth', async () => {
    const res = await post('register', registration());
    expect(res.status).toBe(201);
    expect(messages).toHaveLength(1);
    expect(res.text).not.toMatch(/password|token|company_id/);
    const users = await inspect<{
      id: string;
      company_id: string;
      status: string;
      display_name: string;
      phone: string;
    }>("SELECT * FROM users WHERE email='founder@new-company.test'");
    const user = users.rows[0];
    expect(user?.status).toBe('invited');
    expect(user?.display_name).toBe('المسؤول الأول');
    expect(user?.phone).toBe('+201000000001');
    const companies = await inspect<{ created_by: string; employee_count_range: string }>(
      'SELECT created_by,employee_count_range FROM companies WHERE id=$1',
      [user?.company_id],
    );
    expect(companies.rows[0]?.created_by).toBe(user?.id);
    expect(companies.rows[0]?.employee_count_range).toBe('11-50');
    const blocked = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'founder@new-company.test', password: registration().password });
    expect(blocked.status).toBe(401);
    const link = /https?:[^\s]+#token=[^\s]+/.exec(messages[0]?.text ?? '')?.[0];
    expect(link).toBeTruthy();
    const token = decodeURIComponent(new URL(link as string).hash.slice(7));
    expect(
      (await request(app.getHttpServer()).post('/api/v1/auth/invitation-preview').send({ token }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/accept-invitation')
          .send({ token, password: registration().password, accept_terms: true })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .post('/api/v1/auth/accept-invitation')
          .send({ token, password: registration().password, accept_terms: true })
      ).status,
    ).toBe(400);
    const agent = request.agent(app.getHttpServer());
    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: 'founder@new-company.test', password: registration().password });
    expect(login.status).toBe(200);
    expect(login.headers['set-cookie']).toBeTruthy();
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.role.key).toBe('admin');
    expect(me.body.data.employee).toBeNull();
    expect(me.body.data.company.name).toBe('شركة جديدة');
    expect((await agent.get('/api/v1/company')).status).toBe(200);
    expect((await agent.get('/api/v1/employees')).body.data).toEqual([]);
    expect((await post('register', registration())).status).toBe(409);
  });
  it('rolls back company, user and invitation after a forced failure following the first writes', async () => {
    const before = await inspect<{ n: number }>('SELECT count(*)::int AS n FROM companies');
    vi.spyOn(app.get(InvitationService), 'issue').mockRejectedValueOnce(
      new Error('forced registration failure'),
    );
    expect((await post('register', registration('rollback@new.test'))).status).toBe(500);
    const after = await inspect<{ n: number }>('SELECT count(*)::int AS n FROM companies');
    expect(after.rows).toEqual(before.rows);
    expect((await inspect("SELECT * FROM users WHERE email='rollback@new.test'")).rows).toEqual([]);
    expect(messages).toHaveLength(0);
  });
  it('keeps an invited account on SMTP failure; retry reissues existing invitation without another company', async () => {
    failMail = true;
    const body = registration('retry@new.test');
    expect((await post('register', body)).status).toBe(503);
    failMail = false;
    expect((await post('register', body)).status).toBe(201);
    expect((await inspect("SELECT * FROM users WHERE email='retry@new.test'")).rows).toHaveLength(
      1,
    );
    expect(messages).toHaveLength(1);
  });
  it('does not resend activation with the wrong credentials', async () => {
    const body = registration('protected@new.test');
    expect((await post('register', body)).status).toBe(201);
    expect((await post('register', { ...body, password: 'another-long-passphrase' })).status).toBe(
      409,
    );
    expect(messages).toHaveLength(1);
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
  it('supports English activation email', async () => {
    expect(
      (await post('register', registration('english@new.test')).set('Accept-Language', 'en'))
        .status,
    ).toBe(201);
    expect(messages[0]?.html).toContain('lang="en"');
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
    const link = /https?:[^\s]+#token=[^\s]+/.exec(messages[0]?.text ?? '')?.[0];
    const token = decodeURIComponent(new URL(link as string).hash.slice(7));
    await request(app.getHttpServer())
      .post('/api/v1/auth/accept-invitation')
      .send({ token, password: registration().password, accept_terms: true });
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
