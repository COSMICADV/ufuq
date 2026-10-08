/**
 * Phase 4 end-to-end — DOCUMENT 25 Phase 4, DOCUMENT 26 §§3, 4, 5.
 *
 * Exit criterion for this phase: "a company can be created and fully
 * configured, including a working schedule that is not hardcoded anywhere."
 * Company *creation* is Phase 16 by approved decision, so what is proved here
 * is the rest of it — that a company can be fully configured through the API,
 * that the configuration is the only source of working hours, and that none of
 * it crosses a tenant boundary.
 *
 * The DOCUMENT 26 §3 checklist ("for every endpoint: success · validation
 * failure with field-level errors · unauthenticated · unauthorised role ·
 * cross-tenant record (404) · not found · business conflict · pagination
 * boundaries · unknown request fields rejected") is worked through below, and
 * §5's tenancy rule — "for every endpoint that accepts an id, call it with a
 * valid id belonging to a different company and assert 404" — is asserted for
 * each of the three such endpoints.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security genuinely enforced (`@electric-sql/pglite` is Postgres compiled to
 * WASM). Only Redis is a fake, exactly as in the Phase 3 suite and for the
 * same reason.
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

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

// Every migration, not only Phases 3 and 4: the application under test reads
// the tables later phases add (see `migrations.ts`).
const MIGRATIONS_SQL = allMigrationsSql();

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let redis: FakeRedis;

const COMPANY_A = generateId();
const COMPANY_B = generateId();

/** One admin per company, plus an employee in A — DOCUMENT 02 §4's matrix needs both. */
const ACCOUNTS = {
  adminA: { email: 'admin-a@a.test', password: 'a-genuinely-long-password-one', role: 'admin' },
  adminB: { email: 'admin-b@b.test', password: 'a-genuinely-long-password-two', role: 'admin' },
  employeeA: {
    email: 'staff-a@a.test',
    password: 'a-genuinely-long-password-three',
    role: 'employee',
  },
  managerA: { email: 'lead-a@a.test', password: 'a-genuinely-long-password-four', role: 'manager' },
} as const;

type AccountKey = keyof typeof ACCOUNTS;

const tokens: Record<AccountKey, string> = {
  adminA: '',
  adminB: '',
  employeeA: '',
  managerA: '',
};

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

/** A complete, explicitly configured week. Nothing in the API supplies one. */
function week(
  overrides: Partial<
    Record<number, { is_working_day: boolean; start_time?: string; end_time?: string }>
  > = {},
): unknown[] {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const override = overrides[dayOfWeek];
    if (override) {
      return { day_of_week: dayOfWeek, ...override };
    }
    // Sunday–Thursday worked, Friday and Saturday off — a *fixture*, chosen
    // here in the test, not a value the system knows anything about.
    return dayOfWeek <= 4
      ? { day_of_week: dayOfWeek, is_working_day: true, start_time: '09:00', end_time: '17:00' }
      : { day_of_week: dayOfWeek, is_working_day: false };
  });
}

function validSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Standard week',
    timezone: 'Africa/Cairo',
    grace_period_minutes: 15,
    half_day_threshold_hours: '4.50',
    overtime_policy: 'paid',
    break_minutes: 60,
    days: week(),
    ...overrides,
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

  for (const [id, name, slug] of [
    [COMPANY_A, 'Company A', 'company-a'],
    [COMPANY_B, 'Company B', 'company-b'],
  ] as const) {
    await withTenant(prisma, id, (tx) =>
      tx.company.create({ data: { id, name, slug, timezone: 'Africa/Cairo' } }),
    );
  }

  for (const [key, account] of Object.entries(ACCOUNTS) as [
    AccountKey,
    (typeof ACCOUNTS)[AccountKey],
  ][]) {
    const companyId = key === 'adminB' ? COMPANY_B : COMPANY_A;
    const passwordHash = await hashPassword(account.password);
    await withTenant(prisma, companyId, (tx) =>
      tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: account.email,
          passwordHash,
          roleId: roleIdByKey.get(account.role) as string,
          status: 'active',
        },
      }),
    );
  }
}

/** Mobile login: a Bearer token keeps every request in this file CSRF-free. */
async function login(account: (typeof ACCOUNTS)[AccountKey]): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(`/${API_PREFIX}/auth/login`)
    .set('X-Client-Type', 'mobile')
    .send({ email: account.email, password: account.password });
  if (response.status !== 200) {
    throw new Error(`Fixture login failed for ${account.email}: ${String(response.status)}`);
  }
  return response.body.data.accessToken as string;
}

function as(who: AccountKey) {
  const agent = request(app.getHttpServer());
  const authorize = <T extends { set: (k: string, v: string) => T }>(builder: T): T =>
    builder.set('Authorization', `Bearer ${tokens[who]}`);
  return {
    get: (path: string) => authorize(agent.get(`/${API_PREFIX}${path}`)),
    post: (path: string) => authorize(agent.post(`/${API_PREFIX}${path}`)),
    patch: (path: string) => authorize(agent.patch(`/${API_PREFIX}${path}`)),
    delete: (path: string) => authorize(agent.delete(`/${API_PREFIX}${path}`)),
  };
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
        testEnv(`postgresql://postgres@127.0.0.1:${String(port)}/postgres?connection_limit=1`),
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
  // Listening once, here, matters: given a server that is not listening,
  // supertest listens for each request and closes the server after it, and
  // a request that starts while that close is in progress fails with
  // "socket hang up". `listen` also runs `init`.
  await app.listen(0, '127.0.0.1');

  const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures(prisma);

  // From here on the application connects as the restricted runtime role, so
  // every assertion below runs against real row-level security.
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
    tokens[key] = await login(ACCOUNTS[key]);
  }
}, 60_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

// ---------------------------------------------------------------------------
// Authentication and authorization — DOCUMENT 26 §§3, 4; DOCUMENT 02 §4
// ---------------------------------------------------------------------------

const READ_ENDPOINTS = ['/company', '/departments', '/positions', '/work-schedules', '/holidays'];

describe('authentication — DOCUMENT 09 §4 check 1', () => {
  it.each(READ_ENDPOINTS)('GET %s with no credential is 401', async (path) => {
    const response = await request(app.getHttpServer()).get(`/${API_PREFIX}${path}`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('POST /departments with no credential is 401', async () => {
    const response = await request(app.getHttpServer())
      .post(`/${API_PREFIX}/departments`)
      .send({ name_ar: 'قسم', name_en: 'Dept' });
    expect(response.status).toBe(401);
  });
});

describe('permissions — DOCUMENT 02 §4, DOCUMENT 27 RULES 8 and 9', () => {
  // DOCUMENT 02 §4 "Settings & audit": every settings permission is ADMIN
  // only. A MANAGER holds none of them, an EMPLOYEE holds none of them, and
  // the guard — not the absence of a button — is what says so.
  it.each(READ_ENDPOINTS)('EMPLOYEE cannot read %s (403)', async (path) => {
    const response = await as('employeeA').get(path);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it.each(READ_ENDPOINTS)('MANAGER cannot read %s (403)', async (path) => {
    const response = await as('managerA').get(path);
    expect(response.status).toBe(403);
  });

  it('EMPLOYEE cannot create a department (403)', async () => {
    const response = await as('employeeA')
      .post('/departments')
      .send({ name_ar: 'محاولة', name_en: 'Attempt' });
    expect(response.status).toBe(403);
  });

  it('MANAGER cannot create a work schedule (403)', async () => {
    const response = await as('managerA').post('/work-schedules').send(validSchedule());
    expect(response.status).toBe(403);
  });

  it('ADMIN can read every settings collection', async () => {
    for (const path of READ_ENDPOINTS) {
      const response = await as('adminA').get(path);
      expect(response.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Company — DOCUMENT 08 §4.2, DOCUMENT 06 §3.1
// ---------------------------------------------------------------------------

describe('GET /company', () => {
  it('returns the caller’s own company and nothing about any other', async () => {
    const [a, b] = await Promise.all([as('adminA').get('/company'), as('adminB').get('/company')]);

    expect(a.status).toBe(200);
    expect(a.body.data.id).toBe(COMPANY_A);
    expect(b.body.data.id).toBe(COMPANY_B);
    expect(a.body.meta.locale).toBe('ar');
  });

  it('exposes only the documented fields — no deleted_at, no created_by', async () => {
    const response = await as('adminA').get('/company');
    expect(Object.keys(response.body.data).sort()).toEqual([
      'correction_window_days',
      'currency',
      'default_locale',
      'fiscal_month_start_day',
      'id',
      'logo_path',
      'name',
      'slug',
      'status',
      'timezone',
    ]);
  });
});

describe('PATCH /company', () => {
  it('updates the approved fields and writes settings.company_updated', async () => {
    const response = await as('adminA').patch('/company').send({
      name: '  شركة الأُفق  ',
      timezone: 'Asia/Riyadh',
      currency: 'sar',
      default_locale: 'en',
      fiscal_month_start_day: '٢٦',
    });

    expect(response.status).toBe(200);
    // Trimmed, uppercased, and Arabic-Indic digits normalised — DOCUMENT 08 §5.5.
    expect(response.body.data).toMatchObject({
      name: 'شركة الأُفق',
      timezone: 'Asia/Riyadh',
      currency: 'SAR',
      default_locale: 'en',
      fiscal_month_start_day: 26,
    });

    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const entries = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { action: 'SETTINGS_COMPANY_UPDATED' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityType).toBe('company');
    // DOCUMENT 21: only the fields that changed.
    expect(Object.keys(entries[0]?.newValues as object).sort()).toEqual([
      'currency',
      'default_locale',
      'fiscal_month_start_day',
      'name',
      'timezone',
    ]);
    expect((entries[0]?.oldValues as { currency: string }).currency).toBe('EGP');

    // Restore, so later assertions read the fixture they expect.
    await as('adminA').patch('/company').send({
      name: 'Company A',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      default_locale: 'ar',
      fiscal_month_start_day: 1,
    });
  });

  it('rejects a client-supplied company_id rather than ignoring it', async () => {
    const response = await as('adminA').patch('/company').send({ company_id: COMPANY_B });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.fields.company_id).toBeDefined();
  });

  it('rejects slug and status — not in the approved editable set', async () => {
    const response = await as('adminA')
      .patch('/company')
      .send({ slug: 'stolen-slug', status: 'suspended' });
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields).sort()).toEqual(['slug', 'status']);
  });

  it.each([
    ['a timezone that is not IANA', { timezone: 'Mars/Olympus' }],
    ['a four-letter currency', { currency: 'EGPX' }],
    ['a locale the product does not have', { default_locale: 'fr' }],
    ['a fiscal start day of 0', { fiscal_month_start_day: 0 }],
    ['a fiscal start day of 29', { fiscal_month_start_day: 29 }],
    ['a name of only whitespace', { name: '   ' }],
    ['a name carrying a control character', { name: 'Company A' }],
    ['a name carrying a bidi override', { name: 'Company‮A' }],
  ])('rejects %s with a field-level error', async (_case, body) => {
    const response = await as('adminA').patch('/company').send(body);
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields)).toHaveLength(1);
  });

  it('accepts an empty body as a no-op and writes no audit record for it', async () => {
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const before = await withTenant(prisma, COMPANY_A, (tx) => tx.auditLog.count());

    const response = await as('adminA').patch('/company').send({});
    expect(response.status).toBe(200);

    const after = await withTenant(prisma, COMPANY_A, (tx) => tx.auditLog.count());
    expect(after).toBe(before);
  });

  it('answers both languages from the same endpoint — DOCUMENT 27 RULE 25', async () => {
    const arabic = await as('adminA').patch('/company').send({ currency: 'EGPX' });
    expect(arabic.body.error.message_ar).not.toBe(arabic.body.error.message_en);
    expect(arabic.body.error.message_ar.length).toBeGreaterThan(0);
    expect(arabic.body.error.message_en.length).toBeGreaterThan(0);

    const english = await as('adminA').get('/company').set('Accept-Language', 'en');
    expect(english.body.meta.locale).toBe('en');
  });

  it('configures the attendance correction window — DOCUMENT 12 rule 13', async () => {
    const before = await as('adminA').get('/company');
    // DOCUMENT 12's own default, so an unconfigured company behaves exactly as
    // it did while the window was a constant.
    expect(before.body.data.correction_window_days).toBe(7);

    const response = await as('adminA').patch('/company').send({ correction_window_days: 30 });
    expect(response.status).toBe(200);
    expect(response.body.data.correction_window_days).toBe(30);
  });

  it('refuses a window below one day, or larger than the column can store', async () => {
    for (const value of [0, -1, 32_768]) {
      const response = await as('adminA').patch('/company').send({ correction_window_days: value });
      expect(response.status).toBe(422);
      expect(response.body.error.fields).toHaveProperty('correction_window_days');
    }
  });

  it('sets no documented maximum — a window beyond a year is accepted', async () => {
    const response = await as('adminA').patch('/company').send({ correction_window_days: 366 });
    expect(response.status).toBe(200);
    expect(response.body.data.correction_window_days).toBe(366);
  });
});

// ---------------------------------------------------------------------------
// Departments — DOCUMENT 08 §4.2, DOCUMENT 06 §3.4
// ---------------------------------------------------------------------------

describe('/departments', () => {
  let engineeringId = '';
  let salesId = '';

  it('starts genuinely empty, with a complete pagination envelope', async () => {
    const response = await as('adminA').get('/departments');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta).toMatchObject({ page: 1, per_page: 20, total: 0, total_pages: 1 });
  });

  it('creates a department', async () => {
    const response = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'الهندسة', name_en: 'Engineering' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name_ar: 'الهندسة',
      name_en: 'Engineering',
      parent_id: null,
      status: 'active',
    });
    engineeringId = response.body.data.id as string;
  });

  it('refuses a duplicate Arabic name — (company_id, name_ar) is unique', async () => {
    const response = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'الهندسة', name_en: 'Engineering (again)' });

    expect(response.status).toBe(422);
    expect(response.body.error.fields.name_ar).toEqual(['already_taken']);
  });

  it('lets another company use the same Arabic name — the constraint is per tenant', async () => {
    const response = await as('adminB')
      .post('/departments')
      .send({ name_ar: 'الهندسة', name_en: 'Engineering' });
    expect(response.status).toBe(201);
  });

  it('accepts a parent inside the same company', async () => {
    const response = await as('adminA').post('/departments').send({
      name_ar: 'المبيعات',
      name_en: 'Sales',
      parent_id: engineeringId,
      status: 'inactive',
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ parent_id: engineeringId, status: 'inactive' });
    salesId = response.body.data.id as string;
  });

  it('refuses a parent belonging to another company (422, not a leak)', async () => {
    const theirs = await as('adminB').get('/departments');
    const theirDepartmentId = theirs.body.data[0].id as string;

    const response = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'محاولة', name_en: 'Attempt', parent_id: theirDepartmentId });

    expect(response.status).toBe(422);
    expect(response.body.error.fields.parent_id).toEqual(['not_found']);
    // The response says nothing that distinguishes "belongs to someone else"
    // from "does not exist" — DOCUMENT 08 §3.
    expect(JSON.stringify(response.body)).not.toContain(COMPANY_B);
  });

  it('refuses a status outside the approved set', async () => {
    const response = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'مؤرشف', name_en: 'Archived', status: 'archived' });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.status).toBeDefined();
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const response = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'قسم', name_en: 'Dept', manager_employee_id: generateId() });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.manager_employee_id).toBeDefined();
  });

  it('updates a department, and moving it to the top level is distinct from leaving it alone', async () => {
    const renamed = await as('adminA')
      .patch(`/departments/${salesId}`)
      .send({ name_en: 'Revenue' });
    expect(renamed.status).toBe(200);
    // `parent_id` was absent, so it is untouched.
    expect(renamed.body.data).toMatchObject({ name_en: 'Revenue', parent_id: engineeringId });

    const detached = await as('adminA').patch(`/departments/${salesId}`).send({ parent_id: null });
    expect(detached.body.data.parent_id).toBeNull();

    const reattached = await as('adminA')
      .patch(`/departments/${salesId}`)
      .send({ parent_id: engineeringId });
    expect(reattached.body.data.parent_id).toBe(engineeringId);
  });

  it('refuses a department that would become its own parent', async () => {
    const response = await as('adminA')
      .patch(`/departments/${engineeringId}`)
      .send({ parent_id: engineeringId });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.parent_id).toEqual(['would_create_cycle']);
  });

  it('refuses a longer cycle through an ancestor', async () => {
    // Engineering → Sales would close the loop, since Sales → Engineering.
    const response = await as('adminA')
      .patch(`/departments/${engineeringId}`)
      .send({ parent_id: salesId });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.parent_id).toEqual(['would_create_cycle']);
  });

  it('refuses to remove a department that still has children (409)', async () => {
    const response = await as('adminA').delete(`/departments/${engineeringId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEPARTMENT_HAS_CHILDREN');
  });

  it('refuses to remove a department that still has positions (409)', async () => {
    const created = await as('adminA')
      .post('/positions')
      .send({ title_ar: 'مهندس', title_en: 'Engineer', department_id: salesId });
    expect(created.status).toBe(201);

    const response = await as('adminA').delete(`/departments/${salesId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEPARTMENT_HAS_POSITIONS');
  });

  it('soft-deletes a department with nothing depending on it', async () => {
    const created = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'مؤقت', name_en: 'Temporary' });
    const temporaryId = created.body.data.id as string;

    const deleted = await as('adminA').delete(`/departments/${temporaryId}`);
    expect(deleted.status).toBe(204);

    const listed = await as('adminA').get('/departments');
    expect((listed.body.data as { id: string }[]).map((row) => row.id)).not.toContain(temporaryId);

    // Soft, not gone: the row survives so later phases' history still resolves.
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.department.findFirst({ where: { id: temporaryId } }),
    );
    expect(row?.deletedAt).toBeInstanceOf(Date);

    // …and the Arabic name stays reserved, as DOCUMENT 06 §3.4 specifies.
    const reused = await as('adminA')
      .post('/departments')
      .send({ name_ar: 'مؤقت', name_en: 'Temporary again' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.fields.name_ar).toEqual(['already_taken']);
  });

  it('is 404 for an id belonging to another company — DOCUMENT 26 §5', async () => {
    const theirs = await as('adminB').get('/departments');
    const theirId = theirs.body.data[0].id as string;

    const read = await as('adminA').patch(`/departments/${theirId}`).send({ name_en: 'Hijacked' });
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('NOT_FOUND');

    const removed = await as('adminA').delete(`/departments/${theirId}`);
    expect(removed.status).toBe(404);

    // And the row is genuinely untouched.
    const stillTheirs = await as('adminB').get('/departments');
    expect(stillTheirs.body.data[0].name_en).toBe('Engineering');
  });

  it('is 404 for an id that does not exist anywhere', async () => {
    const response = await as('adminA')
      .patch(`/departments/${generateId()}`)
      .send({ name_en: 'X' });
    expect(response.status).toBe(404);
  });

  it('is 400 for a path id that is not a UUID', async () => {
    const response = await as('adminA').patch('/departments/not-a-uuid').send({ name_en: 'X' });
    expect(response.status).toBe(400);
    // DOCUMENT 08 §3: 400 is "malformed request", and it must not reach the
    // client as the generic internal-error code.
    expect(response.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('never returns another company’s rows, and paginates within its own', async () => {
    const listA = await as('adminA').get('/departments?per_page=100');
    const idsA = (listA.body.data as { id: string }[]).map((row) => row.id);

    const listB = await as('adminB').get('/departments?per_page=100');
    const idsB = (listB.body.data as { id: string }[]).map((row) => row.id);

    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
    expect(listB.body.meta.total).toBe(1);

    const firstPage = await as('adminA').get('/departments?page=1&per_page=1');
    expect(firstPage.body.data).toHaveLength(1);
    expect(firstPage.body.meta).toMatchObject({ page: 1, per_page: 1, total: idsA.length });
    expect(firstPage.body.meta.total_pages).toBe(idsA.length);

    const beyondTheEnd = await as('adminA').get('/departments?page=99&per_page=20');
    expect(beyondTheEnd.status).toBe(200);
    expect(beyondTheEnd.body.data).toEqual([]);
  });

  it.each([
    ['per_page above the documented maximum', '?per_page=101'],
    ['page zero', '?page=0'],
    ['a non-numeric page', '?page=abc'],
    ['an undocumented filter', '?status=active'],
  ])('rejects %s', async (_case, query) => {
    const response = await as('adminA').get(`/departments${query}`);
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Positions — DOCUMENT 08 §4.2, DOCUMENT 06 §3.5
// ---------------------------------------------------------------------------

describe('/positions', () => {
  it('creates a position with no department', async () => {
    const response = await as('adminA')
      .post('/positions')
      .send({ title_ar: 'محاسب', title_en: 'Accountant' });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      title_ar: 'محاسب',
      title_en: 'Accountant',
      department_id: null,
    });
  });

  it('refuses a department belonging to another company', async () => {
    const theirs = await as('adminB').get('/departments');
    const theirDepartmentId = theirs.body.data[0].id as string;

    const response = await as('adminA')
      .post('/positions')
      .send({ title_ar: 'محاولة', title_en: 'Attempt', department_id: theirDepartmentId });

    expect(response.status).toBe(422);
    expect(response.body.error.fields.department_id).toEqual(['not_found']);
  });

  it('refuses a title that is missing or too long', async () => {
    const missing = await as('adminA').post('/positions').send({ title_en: 'Only English' });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields.title_ar).toBeDefined();

    const tooLong = await as('adminA')
      .post('/positions')
      .send({ title_ar: 'أ'.repeat(201), title_en: 'Long' });
    expect(tooLong.status).toBe(422);
    expect(tooLong.body.error.fields.title_ar).toBeDefined();
  });

  it('lists only the caller’s own positions', async () => {
    const mine = await as('adminA').get('/positions?per_page=100');
    const theirs = await as('adminB').get('/positions?per_page=100');

    expect(mine.body.meta.total).toBeGreaterThan(0);
    expect(theirs.body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Work schedules — DOCUMENT 06 §3.7–3.8, DOCUMENT 12, DOCUMENT 27 RULE 12
// ---------------------------------------------------------------------------

describe('/work-schedules', () => {
  let scheduleId = '';

  it('creates a schedule from configuration alone, keeping every value it was given', async () => {
    const response = await as('adminA')
      .post('/work-schedules')
      .send(validSchedule({ is_default: true }));

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'Standard week',
      is_default: true,
      timezone: 'Africa/Cairo',
      grace_period_minutes: 15,
      // A fixed-scale decimal, not a float — 4.5 hours is an ordinary setting.
      half_day_threshold_hours: '4.50',
      overtime_policy: 'paid',
      break_minutes: 60,
    });
    expect(response.body.data.days).toHaveLength(7);
    expect(response.body.data.days[0]).toEqual({
      day_of_week: 0,
      is_working_day: true,
      start_time: '09:00',
      end_time: '17:00',
    });
    expect(response.body.data.days[5]).toEqual({
      day_of_week: 5,
      is_working_day: false,
      start_time: null,
      end_time: null,
    });
    scheduleId = response.body.data.id as string;
  });

  it('accepts a working week no calendar would call conventional', async () => {
    // The point of DOCUMENT 27 RULE 12: the system has no opinion about which
    // days are worked. A Monday-and-Wednesday-only night operation configures
    // itself and nothing objects.
    const response = await as('adminA')
      .post('/work-schedules')
      .send(
        validSchedule({
          name: 'Two nights a week',
          days: week({
            0: { is_working_day: false },
            1: { is_working_day: true, start_time: '18:00', end_time: '23:30' },
            2: { is_working_day: false },
            3: { is_working_day: true, start_time: '18:00', end_time: '23:30' },
            4: { is_working_day: false },
          }),
        }),
      );

    expect(response.status).toBe(201);
    expect(
      (response.body.data.days as { is_working_day: boolean }[]).filter((d) => d.is_working_day),
    ).toHaveLength(2);
  });

  it.each([
    ['six days', week().slice(0, 6)],
    ['eight days', [...week(), { day_of_week: 6, is_working_day: false }]],
  ])('refuses a week of %s', async (_case, days) => {
    const response = await as('adminA').post('/work-schedules').send(validSchedule({ days }));
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toBeDefined();
  });

  it('refuses seven entries that are not seven distinct days', async () => {
    const duplicated = week();
    duplicated[6] = { day_of_week: 0, is_working_day: false };

    const response = await as('adminA')
      .post('/work-schedules')
      .send(validSchedule({ days: duplicated }));
    expect(response.status).toBe(422);
    expect(response.body.error.fields.days).toEqual(['incomplete_week']);
  });

  it('refuses a working day with no hours', async () => {
    const response = await as('adminA')
      .post('/work-schedules')
      .send(validSchedule({ days: week({ 2: { is_working_day: true } }) }));

    expect(response.status).toBe(422);
    expect(response.body.error.fields['days.2']).toEqual(['required']);
  });

  it('refuses a non-working day that still carries hours', async () => {
    const response = await as('adminA')
      .post('/work-schedules')
      .send(
        validSchedule({
          days: week({ 5: { is_working_day: false, start_time: '09:00', end_time: '17:00' } }),
        }),
      );

    expect(response.status).toBe(422);
    expect(response.body.error.fields['days.5']).toEqual(['invalid']);
  });

  it('refuses an end time that is not after the start time', async () => {
    const response = await as('adminA')
      .post('/work-schedules')
      .send(
        validSchedule({
          days: week({ 1: { is_working_day: true, start_time: '17:00', end_time: '09:00' } }),
        }),
      );

    expect(response.status).toBe(422);
    expect(response.body.error.fields['days.1']).toEqual(['end_before_start']);
  });

  it.each([
    ['a 25-hour half-day threshold', { half_day_threshold_hours: '25.00' }],
    ['a zero half-day threshold', { half_day_threshold_hours: '0.00' }],
    ['a half-day threshold that is not a decimal', { half_day_threshold_hours: 'four' }],
    ['a negative grace period', { grace_period_minutes: -1 }],
    ['a grace period longer than a day', { grace_period_minutes: 1441 }],
    ['an overtime policy outside the documented set', { overtime_policy: 'double' }],
    ['a timezone that is not IANA', { timezone: 'Nowhere/Nothing' }],
  ])('refuses %s', async (_case, overrides) => {
    const response = await as('adminA').post('/work-schedules').send(validSchedule(overrides));
    expect(response.status).toBe(422);
  });

  it('accepts Arabic-Indic digits in the numeric fields', async () => {
    const response = await as('adminA')
      .post('/work-schedules')
      .send(
        validSchedule({
          name: 'Arabic numerals',
          grace_period_minutes: '١٠',
          break_minutes: '٣٠',
          half_day_threshold_hours: '٤.٥',
        }),
      );

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      grace_period_minutes: 10,
      break_minutes: 30,
      half_day_threshold_hours: '4.50',
    });
  });

  it('keeps exactly one default per company, and each company keeps its own', async () => {
    const promoted = await as('adminA')
      .post('/work-schedules')
      .send(validSchedule({ name: 'New default', is_default: true }));
    expect(promoted.status).toBe(201);

    const mine = await as('adminA').get('/work-schedules?per_page=100');
    const defaults = (mine.body.data as { is_default: boolean }[]).filter((row) => row.is_default);
    expect(defaults).toHaveLength(1);

    const theirs = await as('adminB')
      .post('/work-schedules')
      .send(validSchedule({ is_default: true }));
    expect(theirs.status).toBe(201);

    const mineAfter = await as('adminA').get('/work-schedules?per_page=100');
    expect(
      (mineAfter.body.data as { is_default: boolean }[]).filter((r) => r.is_default),
    ).toHaveLength(1);
  });

  it('updates one field without restating the week', async () => {
    const response = await as('adminA')
      .patch(`/work-schedules/${scheduleId}`)
      .send({ grace_period_minutes: 5 });

    expect(response.status).toBe(200);
    expect(response.body.data.grace_period_minutes).toBe(5);
    expect(response.body.data.days).toHaveLength(7);
    expect(response.body.data.days[0].start_time).toBe('09:00');
  });

  it('replaces the whole week when days are supplied', async () => {
    const response = await as('adminA')
      .patch(`/work-schedules/${scheduleId}`)
      .send({
        days: week({
          0: { is_working_day: false },
          1: { is_working_day: true, start_time: '08:00', end_time: '16:00' },
        }),
      });

    expect(response.status).toBe(200);
    expect(response.body.data.days[0]).toMatchObject({ is_working_day: false, start_time: null });
    expect(response.body.data.days[1]).toMatchObject({ start_time: '08:00', end_time: '16:00' });
    // Still exactly seven rows — the replacement is not an append.
    expect(response.body.data.days).toHaveLength(7);
  });

  it('refuses a partial week on update too', async () => {
    const response = await as('adminA')
      .patch(`/work-schedules/${scheduleId}`)
      .send({ days: week().slice(0, 3) });
    expect(response.status).toBe(422);
  });

  it('writes settings.schedule_changed for every create and every change', async () => {
    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const entries = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({
        where: { action: 'SETTINGS_SCHEDULE_CHANGED', entityType: 'work_schedule' },
        orderBy: { createdAt: 'asc' },
      }),
    );

    expect(entries.length).toBeGreaterThanOrEqual(2);
    // The update above recorded both sides of the change, changed fields only.
    const withOldValues = entries.filter((entry) => entry.oldValues !== null);
    expect(withOldValues.length).toBeGreaterThan(0);
    const changed = Object.keys(withOldValues.at(-1)?.newValues as object);
    expect(changed).not.toContain('id');
    expect(changed).not.toContain('updated_at');
  });

  it('is 404 for a schedule belonging to another company', async () => {
    const theirs = await as('adminB').get('/work-schedules');
    const theirId = theirs.body.data[0].id as string;

    const response = await as('adminA')
      .patch(`/work-schedules/${theirId}`)
      .send({ grace_period_minutes: 0 });
    expect(response.status).toBe(404);
  });

  it('never returns another company’s schedules', async () => {
    const mine = await as('adminA').get('/work-schedules?per_page=100');
    const theirs = await as('adminB').get('/work-schedules?per_page=100');

    const mineIds = (mine.body.data as { id: string }[]).map((r) => r.id);
    const theirIds = (theirs.body.data as { id: string }[]).map((r) => r.id);
    expect(mineIds.some((id) => theirIds.includes(id))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Holidays — DOCUMENT 06 §3.9, DOCUMENT 12
// ---------------------------------------------------------------------------

describe('/holidays', () => {
  it('creates a holiday and audits it as a schedule change', async () => {
    const response = await as('adminA').post('/holidays').send({
      date: '2026-01-07',
      name_ar: 'عيد الميلاد المجيد',
      name_en: 'Christmas',
      is_recurring: true,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      date: '2026-01-07',
      name_ar: 'عيد الميلاد المجيد',
      is_recurring: true,
    });

    const prisma = app.get<PrismaClient>(PRISMA_CLIENT);
    const entries = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { entityType: 'holiday' } }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('SETTINGS_SCHEDULE_CHANGED');
  });

  it('refuses a second holiday on the same date', async () => {
    const response = await as('adminA')
      .post('/holidays')
      .send({ date: '2026-01-07', name_ar: 'مكرر', name_en: 'Duplicate' });

    expect(response.status).toBe(422);
    expect(response.body.error.fields.date).toEqual(['already_taken']);
  });

  it('lets another company hold the same date', async () => {
    const response = await as('adminB')
      .post('/holidays')
      .send({ date: '2026-01-07', name_ar: 'عيد', name_en: 'Holiday' });
    expect(response.status).toBe(201);
  });

  it.each([
    ['a date that does not exist', '2026-02-30'],
    ['a date in the wrong format', '07/01/2026'],
    ['a date with no day', '2026-01'],
  ])('refuses %s', async (_case, date) => {
    const response = await as('adminA')
      .post('/holidays')
      .send({ date, name_ar: 'خطأ', name_en: 'Bad' });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.date).toBeDefined();
  });

  it('accepts a leap day in a leap year', async () => {
    const response = await as('adminA')
      .post('/holidays')
      .send({ date: '2028-02-29', name_ar: 'يوم كبيسة', name_en: 'Leap day' });
    expect(response.status).toBe(201);
    expect(response.body.data.date).toBe('2028-02-29');
  });

  it('returns the date as a plain calendar date, not an instant', async () => {
    const response = await as('adminA').get('/holidays?per_page=100');
    for (const holiday of response.body.data as { date: string }[]) {
      expect(holiday.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('lists in chronological order and only for the caller’s company', async () => {
    const mine = await as('adminA').get('/holidays?per_page=100');
    const dates = (mine.body.data as { date: string }[]).map((row) => row.date);
    expect(dates).toEqual([...dates].sort());

    const theirs = await as('adminB').get('/holidays?per_page=100');
    expect(theirs.body.meta.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The exit criterion, end to end
// ---------------------------------------------------------------------------

describe('DOCUMENT 25 Phase 4 exit criterion', () => {
  it('a company can be fully configured, and its working hours come only from what it configured', async () => {
    const company = await as('adminA').get('/company');
    expect(company.status).toBe(200);

    const [departments, positions, schedules, holidays] = await Promise.all([
      as('adminA').get('/departments?per_page=100'),
      as('adminA').get('/positions?per_page=100'),
      as('adminA').get('/work-schedules?per_page=100'),
      as('adminA').get('/holidays?per_page=100'),
    ]);

    expect(departments.body.meta.total).toBeGreaterThan(0);
    expect(positions.body.meta.total).toBeGreaterThan(0);
    expect(schedules.body.meta.total).toBeGreaterThan(0);
    expect(holidays.body.meta.total).toBeGreaterThan(0);

    // Every schedule states its own week in full. Nothing downstream will ever
    // need to fall back on a constant, because there is no day left undefined.
    for (const schedule of schedules.body.data as { days: { day_of_week: number }[] }[]) {
      expect(schedule.days.map((day) => day.day_of_week)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
});
