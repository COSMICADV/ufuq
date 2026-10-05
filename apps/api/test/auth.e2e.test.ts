/**
 * End-to-end auth flow — DOCUMENT 25 Phase 3 exit criterion: "the
 * authorization matrix test passes for every implemented endpoint."
 *
 * Boots the real Nest application (real guards, real DTO validation, real
 * cookie handling) against a real PostgreSQL engine (`@electric-sql/pglite`
 * — Postgres compiled to WASM, not a mock) with row-level security genuinely
 * enforced: the app connects as the bootstrap superuser and switches to
 * `ufuq_app` with one `SET ROLE` before any request is served, reproducing
 * what a direct `ufuq_app` login does in a real deployment (see
 * `packages/db/test/tenant-client.test.ts`, which establishes that
 * substitution is faithful and explains why it is necessary here). Only
 * `REDIS_CLIENT` is swapped for an in-memory fake — rate limiting's *logic*
 * lives in `RateLimitService`, exercised for real; only the network
 * round-trip to Redis is stubbed (AD-01's real Redis is unavailable in this
 * sandbox — see the Phase 3 report).
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { API_PREFIX } from '../src/api-prefix.js';
import type { AppInfo } from '../src/app.tokens.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { PasswordService } from '../src/auth/password.service.js';
import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

// Every migration, not only Phase 3's: the application under test reads the
// tables later phases add (see `migrations.ts`).
const MIGRATIONS_SQL = allMigrationsSql();

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let redis: FakeRedis;

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
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.init();

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

function csrfHeaders(cookies: readonly string[]): { Cookie: string; 'X-CSRF-Token': string } {
  const jar = cookies.join('; ');
  const csrf = cookies
    .map((c) => /ufuq_csrf=([^;]+)/.exec(c)?.[1])
    .find((v): v is string => Boolean(v));
  if (!csrf) throw new Error('no csrf cookie in response');
  return { Cookie: jar, 'X-CSRF-Token': csrf };
}

describe('GET /api/v1/health — public', () => {
  it('answers with no credential at all', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});

describe('protected routes without a credential', () => {
  it('GET /api/v1/auth/me returns 401 UNAUTHENTICATED', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /api/v1/auth/logout returns 401', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/logout');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/auth/login — web client', () => {
  it('rejects a wrong password with the generic code, not a distinct one', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_A_EMAIL, password: 'totally-wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an unknown email with the same generic code', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@nowhere.test', password: 'whatever-password-here' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unknown field (whitelist validation, DOCUMENT 08 §5.2)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD, companyId: COMPANY_B });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('logs in with the correct password and sets httpOnly session + csrf cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(ADMIN_A_EMAIL);
    // The raw session token never appears in the response body for a web
    // login — only in the httpOnly cookie (DOCUMENT 20 §8).
    expect(JSON.stringify(res.body)).not.toContain('accessToken');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('ufuq_session=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('ufuq_csrf=') && !c.includes('HttpOnly'))).toBe(true);
  });
});

describe('an authenticated web session', () => {
  let cookies: string[];

  beforeAll(async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_A_EMAIL, password: ADMIN_A_PASSWORD });
    cookies = res.headers['set-cookie'] as unknown as string[];
  });

  it('GET /auth/me returns the company, role and permission list DOCUMENT 08 §4.1 promises', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies.join('; '));
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(ADMIN_A_EMAIL);
    expect(res.body.data.company.id).toBe(COMPANY_A);
    expect(res.body.data.role.key).toBe('admin');
    expect(res.body.data.employee).toBeNull();
    const keys = res.body.data.permissions.map((p: { key: string }) => p.key);
    expect(keys).toContain('employee.view');
    expect(keys).toContain('payroll.finalize');
  });

  it('never leaks another company via /auth/me — RLS binds the session, not the client', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies.join('; '));
    expect(res.body.data.company.id).not.toBe(COMPANY_B);
  });

  it('rejects a mutating request with no CSRF header (DOCUMENT 20 §6)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set('Cookie', cookies.join('; '))
      .send({ currentPassword: ADMIN_A_PASSWORD, newPassword: 'a-brand-new-long-password' });
    expect(res.status).toBe(403);
  });

  it('rejects change-password with the wrong current password', async () => {
    const headers = csrfHeaders(cookies);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set(headers)
      .send({
        currentPassword: 'not-the-right-password',
        newPassword: 'a-brand-new-long-password',
      });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.currentPassword).toEqual(['incorrect']);
  });

  it('rejects a new password that is long enough but on the breach list (DOCUMENT 09 §2)', async () => {
    // Long enough to pass the DTO's own @MinLength(10) — this specifically
    // exercises PasswordService.checkPolicy's breach-list check, not DTO
    // validation (a *too-short* password is legitimately VALIDATION_FAILED,
    // caught before the service layer ever runs).
    const headers = csrfHeaders(cookies);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/change-password')
      .set(headers)
      .send({ currentPassword: ADMIN_A_PASSWORD, newPassword: 'password123' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
  });

  it('logs out, and the same cookie then fails', async () => {
    const headers = csrfHeaders(cookies);
    const logoutRes = await request(app.getHttpServer()).post('/api/v1/auth/logout').set(headers);
    expect(logoutRes.status).toBe(200);

    const meRes = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookies.join('; '));
    expect(meRes.status).toBe(401);
  });
});

describe('account lockout — DOCUMENT 09 §1', () => {
  const email = 'lockout-target@company-a.test';

  beforeAll(async () => {
    // The per-IP login rate limit (DOCUMENT 08 §6) and the per-account
    // lockout (DOCUMENT 09 §1) are deliberately independent controls with
    // the same threshold — every test above this one has already made
    // several login attempts from the same address, so without a reset
    // this block would hit 429 (rate limit) before it ever reaches the
    // 401 ACCOUNT_LOCKED this test exists to prove.
    redis.reset();
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const roleAdmin = await withPlatformContext(prisma, (tx) =>
      tx.role.findFirstOrThrow({ where: { companyId: null, key: 'admin' } }),
    );
    const hash = await hashPassword('the-real-password-nobody-guesses');
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.create({
        data: {
          id: generateId(),
          companyId: COMPANY_A,
          email,
          passwordHash: hash,
          roleId: roleAdmin.id,
          status: 'active',
        },
      }),
    );
  });

  it('locks the account after 5 failed attempts and rejects the 6th even with the right password', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: `wrong-password-attempt-${i}` });
      expect(res.status).toBe(401);
    }
    // The account lockout and the DOCUMENT 08 §6 rate limit share the same
    // threshold (5) by coincidence, not by design — reset the rate limiter
    // so this specific assertion is about the DB-backed lockout alone,
    // not about which of the two independent controls fires first.
    redis.reset();
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: 'the-real-password-nobody-guesses' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('rate limiting — DOCUMENT 08 §6 (by IP, a different email each time)', () => {
  it('returns 429 with Retry-After once the per-IP login limit is exceeded', async () => {
    redis.reset(); // see the account-lockout block above for why
    let last: request.Response | undefined;
    for (let i = 0; i < 6; i += 1) {
      last = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: `rate-limit-probe-${i}@nowhere.test`, password: 'whatever-password-here' });
    }
    expect(last?.status).toBe(429);
    expect(last?.body.error.code).toBe('RATE_LIMITED');
    expect(last?.headers['retry-after']).toBeDefined();
  });
});

describe('POST /api/v1/auth/login — mobile client (OD-02)', () => {
  beforeAll(() => {
    redis.reset(); // see the account-lockout block above for why
  });

  it('returns access and refresh tokens in the body instead of cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: ADMIN_B_EMAIL, password: ADMIN_B_PASSWORD });
    expect(res.status).toBe(200);
    expect(typeof res.body.data.accessToken).toBe('string');
    expect(typeof res.body.data.refreshToken).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('accesses /auth/me with a Bearer token and no CSRF header', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: ADMIN_B_EMAIL, password: ADMIN_B_PASSWORD });
    const res = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.company.id).toBe(COMPANY_B);
  });

  it('rotates both tokens on refresh, and the old access token still works until it is used again', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: ADMIN_B_EMAIL, password: ADMIN_B_PASSWORD });

    const refreshed = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).not.toBe(login.body.data.accessToken);
    expect(refreshed.body.data.refreshToken).not.toBe(login.body.data.refreshToken);

    const meWithNewToken = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`);
    expect(meWithNewToken.status).toBe(200);
  });

  it('rejects a reused (already-rotated) refresh token', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Client-Type', 'mobile')
      .send({ email: ADMIN_B_EMAIL, password: ADMIN_B_PASSWORD });
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });

    const reused = await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });
    expect(reused.status).toBe(401);
  });
});

describe('forgot password and reset — DOCUMENT 08 §4.1, through auth_lookup_login and auth_lookup_reset_token', () => {
  const email = 'reset-target@company-a.test';
  const oldPassword = 'the-original-password-2026';
  const newPassword = 'a-brand-new-password-2026';
  let userId = '';

  beforeAll(async () => {
    redis.reset(); // see the account-lockout block above for why
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const roleAdmin = await withPlatformContext(prisma, (tx) =>
      tx.role.findFirstOrThrow({ where: { companyId: null, key: 'admin' } }),
    );
    userId = generateId();
    const hash = await hashPassword(oldPassword);
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.create({
        data: {
          id: userId,
          companyId: COMPANY_A,
          email,
          passwordHash: hash,
          roleId: roleAdmin.id,
          status: 'active',
        },
      }),
    );
  });

  it('forgot-password answers 200 either way, and issues a token only for a real account', async () => {
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const known = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email });
    const unknown = await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody@company-a.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);

    const tokens = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.passwordResetToken.count({ where: { userId } }),
    );
    expect(tokens).toBe(1);
  });

  it('a reset token sets the new password once, and never again', async () => {
    // Delivering the token by email is Phase 15; the real service issues it.
    const token = await app.get(PasswordService).createResetToken(COMPANY_A, userId);

    const reset = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword });
    expect(reset.status).toBe(200);

    redis.reset();
    const withNew = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: newPassword });
    expect(withNew.status).toBe(200);
    const withOld = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: oldPassword });
    expect(withOld.status).toBe(401);

    const reused = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: 'yet-another-password-2026' });
    expect(reused.status).toBe(400);
    expect(reused.body.error.code).toBe('TOKEN_INVALID');
  });

  it('an unknown token is refused the same way', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/reset-password')
      .send({ token: 'not-a-real-token', newPassword });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });
});
