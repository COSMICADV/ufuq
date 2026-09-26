/**
 * Phase 5 end-to-end — DOCUMENT 25 Phase 5, DOCUMENT 26 §§2–5.
 *
 * Exit criterion: "employees can be created, invited, and manage their own
 * login; the last-admin guard works."
 *
 * Every part of that sentence is exercised through HTTP, against the real
 * application: an admin creates employees (one transaction — and a forced
 * failure proves it), the invitation email is captured at the transport a real
 * SMTP relay would receive it at, the invitee redeems the emailed token, signs
 * in, reads their own employee record and changes their own password, and the
 * company's only active admin is refused when they try to demote or deactivate
 * themselves — until a second admin exists.
 *
 * Around that, the DOCUMENT 26 §3 checklist for every endpoint: success,
 * validation with field-level errors, 401, 403 by role, 403 out of scope,
 * 404 cross-tenant, 404 not found, 409 conflicts, pagination and sort
 * whitelist, unknown fields rejected — and the DOCUMENT 21 audit records each
 * change must leave.
 *
 * Real Nest, guards, DTO validation and PostgreSQL row-level security (PGlite).
 * Redis and the SMTP transport are the only substitutes.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { AuditAction, PrismaClient } from '@ufuq/db';
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
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Captures what the SMTP relay would receive; can be told to refuse. */
class CapturingMailTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  failing = false;

  async send(message: MailMessage): Promise<void> {
    if (this.failing) {
      throw new Error('relay refused the message');
    }
    this.sent.push(message);
  }

  lastTo(address: string): MailMessage {
    const message = [...this.sent].reverse().find((candidate) => candidate.to === address);
    if (!message) {
      throw new Error(`No mail was sent to ${address}`);
    }
    return message;
  }

  countTo(address: string): number {
    return this.sent.filter((candidate) => candidate.to === address).length;
  }
}

function tokenFrom(message: MailMessage): string {
  const match = /#token=([^\s"<]+)/.exec(message.text);
  if (!match?.[1]) {
    throw new Error('No token in the invitation email');
  }
  return decodeURIComponent(match[1]);
}

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let prisma: PrismaClient;
const redis = new FakeRedis();
const mail = new CapturingMailTransport();

const COMPANY_A = generateId();
const COMPANY_B = generateId();
/** A company whose only admin has an employee record — the last-admin guard. */
const COMPANY_C = generateId();

const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-long-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-long-password-2026' };
const ADMIN_C = { email: 'owner@c.test', password: 'admin-c-long-password-2026' };
let adminCEmployeeId = '';

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

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
    },
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

async function seedFixtures(): Promise<void> {
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

  const adminRoleId = roleIdByKey.get('admin') as string;
  for (const [companyId, slug, admin] of [
    [COMPANY_A, 'company-a', ADMIN_A],
    [COMPANY_B, 'company-b', ADMIN_B],
    [COMPANY_C, 'company-c', ADMIN_C],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: { id: companyId, name: slug, slug, timezone: 'Africa/Cairo' },
      });
      const userId = generateId();
      await tx.user.create({
        data: {
          id: userId,
          companyId,
          email: admin.email,
          passwordHash,
          roleId: adminRoleId,
          status: 'active',
        },
      });
      if (companyId === COMPANY_C) {
        const scheduleId = generateId();
        await tx.workSchedule.create({
          data: {
            id: scheduleId,
            companyId,
            name: 'Week',
            timezone: 'Africa/Cairo',
            halfDayThresholdHours: '4.00',
          },
        });
        adminCEmployeeId = generateId();
        await tx.employee.create({
          data: {
            id: adminCEmployeeId,
            companyId,
            userId,
            employeeCode: 'C-OWNER',
            firstName: 'Only',
            lastName: 'Admin',
            email: admin.email,
            workScheduleId: scheduleId,
            joiningDate: new Date('2025-01-01T00:00:00.000Z'),
          },
        });
      }
    });
  }
}

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.exec(allMigrationsSql());

  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  let port = 0;
  socket.addEventListener('listening', (event) => {
    port = (event as Event & { detail: { port: number } }).detail.port;
  });
  await socket.start();

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
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(mail)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.init();

  prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures();
  // Every request from here on runs as the restricted runtime role.
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
}, 60_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

/** Mobile login — a Bearer token keeps requests CSRF-free. The rate limiter is reset first. */
async function login(email: string, password: string): Promise<request.Response> {
  redis.reset();
  return request(server())
    .post(`/${API_PREFIX}/auth/login`)
    .set('X-Client-Type', 'mobile')
    .send({ email, password });
}

async function tokenFor(email: string, password: string): Promise<string> {
  const response = await login(email, password);
  if (response.status !== 200) {
    throw new Error(
      `Login failed for ${email}: ${String(response.status)} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.data.accessToken as string;
}

function as(token: string) {
  const agent = request(server());
  const auth = <T extends { set: (key: string, value: string) => T }>(builder: T): T =>
    builder.set('Authorization', `Bearer ${token}`);
  return {
    get: (path: string) => auth(agent.get(`/${API_PREFIX}${path}`)),
    post: (path: string) => auth(agent.post(`/${API_PREFIX}${path}`)),
    patch: (path: string) => auth(agent.patch(`/${API_PREFIX}${path}`)),
    delete: (path: string) => auth(agent.delete(`/${API_PREFIX}${path}`)),
  };
}

function anonymous() {
  const agent = request(server());
  return {
    get: (path: string) => agent.get(`/${API_PREFIX}${path}`),
    post: (path: string) => agent.post(`/${API_PREFIX}${path}`),
    patch: (path: string) => agent.patch(`/${API_PREFIX}${path}`),
  };
}

function week(): unknown[] {
  // A fixture chosen by this test — nothing in the system knows a working week.
  return Array.from({ length: 7 }, (_, day) =>
    day <= 4
      ? { day_of_week: day, is_working_day: true, start_time: '09:00', end_time: '17:00' }
      : { day_of_week: day, is_working_day: false },
  );
}

interface References {
  readonly departmentId: string;
  readonly otherDepartmentId: string;
  readonly positionId: string;
  readonly scheduleId: string;
}

async function createReferences(token: string, suffix: string): Promise<References> {
  const api = as(token);
  const department = await api
    .post('/departments')
    .send({ name_ar: `قسم ${suffix}`, name_en: `Dept ${suffix}` });
  const other = await api
    .post('/departments')
    .send({ name_ar: `قسم آخر ${suffix}`, name_en: `Other ${suffix}` });
  const position = await api
    .post('/positions')
    .send({ title_ar: `مسمى ${suffix}`, title_en: `Title ${suffix}` });
  const schedule = await api.post('/work-schedules').send({
    name: `Week ${suffix}`,
    timezone: 'Africa/Cairo',
    grace_period_minutes: 10,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'none',
    break_minutes: 30,
    is_default: true,
    days: week(),
  });
  for (const response of [department, other, position, schedule]) {
    if (response.status !== 201) {
      throw new Error(
        `Reference fixture failed: ${String(response.status)} ${JSON.stringify(response.body)}`,
      );
    }
  }
  return {
    departmentId: department.body.data.id as string,
    otherDepartmentId: other.body.data.id as string,
    positionId: position.body.data.id as string,
    scheduleId: schedule.body.data.id as string,
  };
}

async function audits(companyId: string, entityId: string, action?: AuditAction) {
  return withTenant(prisma, companyId, (tx) =>
    tx.auditLog.findMany({
      where: { entityId, ...(action === undefined ? {} : { action }) },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function auditCount(companyId: string): Promise<number> {
  return withTenant(prisma, companyId, (tx) => tx.auditLog.count());
}

// ---------------------------------------------------------------------------
// Shared state, built up in order as the suite runs
// ---------------------------------------------------------------------------

let adminA = '';
let adminB = '';
let adminC = '';
let refsA: References;
let refsB: References;
let employeeB = '';

let sequence = 0;
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  sequence += 1;
  return {
    first_name: 'Test',
    last_name: `Person ${String(sequence)}`,
    email: `person${String(sequence)}@a.test`,
    employee_code: `EMP-${String(sequence).padStart(4, '0')}`,
    work_schedule_id: refsA.scheduleId,
    joining_date: '2026-01-15',
    role_key: 'employee',
    send_invitation: false,
    ...overrides,
  };
}

const MONA = {
  email: 'mona@a.test',
  password: 'mona-first-password-2026',
  next: 'mona-second-password-2026',
};
const OMAR = { email: 'omar@a.test', password: 'omar-long-password-2026' };
let mona = '';
let omar = '';
let layla = '';
let monaToken = '';
let omarToken = '';

const UNKNOWN_ID = '0192f7a0-0000-7000-8000-0000000fffff';

beforeAll(async () => {
  adminA = await tokenFor(ADMIN_A.email, ADMIN_A.password);
  adminB = await tokenFor(ADMIN_B.email, ADMIN_B.password);
  adminC = await tokenFor(ADMIN_C.email, ADMIN_C.password);
  refsA = await createReferences(adminA, 'A');
  refsB = await createReferences(adminB, 'B');

  const created = await as(adminB).post('/employees').send({
    first_name: 'Bee',
    last_name: 'Tenant',
    email: 'bee@b.test',
    employee_code: 'B-001',
    work_schedule_id: refsB.scheduleId,
    joining_date: '2026-02-01',
    role_key: 'employee',
    send_invitation: false,
  });
  if (created.status !== 201) {
    throw new Error(`Company B fixture failed: ${JSON.stringify(created.body)}`);
  }
  employeeB = created.body.data.id as string;
}, 60_000);

// ---------------------------------------------------------------------------
// DOCUMENT 09 §4 check 1
// ---------------------------------------------------------------------------

describe('authentication — every endpoint requires a session', () => {
  it.each([
    ['get', '/employees'],
    ['post', '/employees'],
    ['get', `/employees/${UNKNOWN_ID}`],
    ['patch', `/employees/${UNKNOWN_ID}`],
    ['post', `/employees/${UNKNOWN_ID}/deactivate`],
    ['post', `/employees/${UNKNOWN_ID}/activate`],
    ['post', `/employees/${UNKNOWN_ID}/invite`],
  ] as const)('%s %s with no credential is 401', async (method, path) => {
    const response = await anonymous()[method](path).send({});
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// FLOW 02 — creation
// ---------------------------------------------------------------------------

describe('POST /employees — FLOW 02, one transaction', () => {
  it('creates the login user and the employee together, emails the invitation, and audits both', async () => {
    const response = await as(adminA).post('/employees').send({
      first_name: 'Mona',
      last_name: 'Saleh',
      email: MONA.email,
      phone: '+20 100 000 0000',
      employee_code: 'MGR-7351',
      department_id: refsA.departmentId,
      position_id: refsA.positionId,
      work_schedule_id: refsA.scheduleId,
      joining_date: '2025-06-01',
      role_key: 'manager',
      send_invitation: true,
    });

    expect(response.status).toBe(201);
    expect(response.body.meta.invitation_delivery).toBe('sent');
    const data = response.body.data;
    mona = data.id as string;
    expect(data).toMatchObject({
      employee_code: 'MGR-7351',
      first_name: 'Mona',
      email: MONA.email,
      department: { id: refsA.departmentId },
      position: { id: refsA.positionId },
      manager: null,
      work_schedule: { id: refsA.scheduleId },
      joining_date: '2025-06-01',
      status: 'active',
      account: { status: 'invited', role_key: 'manager' },
    });
    expect(data.account.invitation_expires_at).not.toBeNull();
    // Nothing sensitive is ever part of the payload.
    expect(JSON.stringify(data)).not.toMatch(/password|token|salary/i);

    const message = mail.lastTo(MONA.email);
    expect(message.text).toContain('http://localhost:3000/ar/accept-invitation#token=');
    expect(message.subject).toContain('company-a');

    const user = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirstOrThrow({ where: { email: MONA.email } }),
    );
    expect(user.status).toBe('invited');
    expect(user.passwordHash).toBeNull();

    const [created] = await audits(COMPANY_A, mona, 'EMPLOYEE_CREATED');
    expect(created?.newValues).toMatchObject({ employee_code: 'MGR-7351', role_key: 'manager' });
    const [sent] = await audits(COMPANY_A, user.id, 'INVITATION_SENT');
    expect(sent).toBeDefined();
    // DOCUMENT 21: tokens and passwords are never captured.
    expect(JSON.stringify([created, sent])).not.toContain(tokenFrom(message));
  });

  it('does not send an invitation when not asked to', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(body({ first_name: 'Layla', email: 'layla@a.test', send_invitation: false }));
    expect(response.status).toBe(201);
    expect(response.body.meta.invitation_delivery).toBe('not_requested');
    expect(response.body.data.account).toMatchObject({
      status: 'invited',
      invitation_expires_at: null,
    });
    expect(mail.countTo('layla@a.test')).toBe(0);
    layla = response.body.data.id as string;
  });

  it('rejects unknown fields, company_id included (DOCUMENT 08 §1, §5.2)', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(body({ company_id: COMPANY_B }));
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('company_id');
  });

  it('reports every missing required field at once', async () => {
    const response = await as(adminA).post('/employees').send({});
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields)).toEqual(
      expect.arrayContaining([
        'first_name',
        'last_name',
        'email',
        'employee_code',
        'work_schedule_id',
        'joining_date',
        'role_key',
        'send_invitation',
      ]),
    );
  });

  it('refuses a date that does not exist and a role no company may assign', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(body({ joining_date: '2026-02-30', role_key: 'super_admin' }));
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toMatchObject({
      joining_date: ['invalid'],
      role_key: ['invalid'],
    });
  });

  it('normalises the email to lowercase and Arabic-Indic digits in the phone', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(body({ email: 'Upper.Case@A.Test', phone: '+٢٠١٠٠٠٠٠٠٠٠٠' }));
    expect(response.status).toBe(201);
    expect(response.body.data.email).toBe('upper.case@a.test');
    expect(response.body.data.phone).toBe('+201000000000');
  });

  it('refuses a taken employee code and an email any login in the company already uses', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(body({ employee_code: 'MGR-7351', email: ADMIN_A.email }));
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({
      email: ['already_taken'],
      employee_code: ['already_taken'],
    });
  });

  it('lets another company reuse the same employee code and email', async () => {
    const response = await as(adminB)
      .post('/employees')
      .send({
        ...body({ employee_code: 'MGR-7351', email: MONA.email }),
        work_schedule_id: refsB.scheduleId,
      });
    expect(response.status).toBe(201);
  });

  it('reports every bad reference, and another company’s ids exactly like missing ones', async () => {
    const response = await as(adminA)
      .post('/employees')
      .send(
        body({
          department_id: refsB.departmentId,
          position_id: UNKNOWN_ID,
          manager_id: employeeB,
          work_schedule_id: refsB.scheduleId,
        }),
      );
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({
      department_id: ['not_found'],
      position_id: ['not_found'],
      manager_id: ['not_found'],
      work_schedule_id: ['not_found'],
    });
  });

  it('writes nothing at all when the employee insert fails after the user insert (DOCUMENT 26 §2)', async () => {
    // A failure injected *inside* the transaction, after the user row is written.
    await prisma.$executeRawUnsafe('RESET ROLE');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_force_employee_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.employee_code = 'FORCE-FAIL' THEN
          RAISE EXCEPTION 'forced failure';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_force_employee_failure BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION test_force_employee_failure()',
    );
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

    const before = await auditCount(COMPANY_A);
    try {
      const response = await as(adminA)
        .post('/employees')
        .send(
          body({ employee_code: 'FORCE-FAIL', email: 'rollback@a.test', send_invitation: true }),
        );
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
    } finally {
      await prisma.$executeRawUnsafe('RESET ROLE');
      await prisma.$executeRawUnsafe('DROP TRIGGER test_force_employee_failure ON employees');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_force_employee_failure()');
      await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    }

    const user = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirst({ where: { email: 'rollback@a.test' } }),
    );
    expect(user).toBeNull();
    expect(await auditCount(COMPANY_A)).toBe(before);
    expect(mail.countTo('rollback@a.test')).toBe(0);
  });

  it('keeps the employee when the relay refuses the invitation, and says so in meta', async () => {
    mail.failing = true;
    try {
      const response = await as(adminA)
        .post('/employees')
        .send(body({ email: 'relay-down@a.test', send_invitation: true }));
      expect(response.status).toBe(201);
      expect(response.body.meta.invitation_delivery).toBe('failed');
      const user = await withTenant(prisma, COMPANY_A, (tx) =>
        tx.user.findFirstOrThrow({ where: { email: 'relay-down@a.test' } }),
      );
      // Nothing was sent, so nothing is audited as sent.
      expect(await audits(COMPANY_A, user.id, 'INVITATION_SENT')).toHaveLength(0);
    } finally {
      mail.failing = false;
    }
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 04 A4 — what the acceptance page shows, and what it makes the
// invitee agree to, before a password is chosen
// ---------------------------------------------------------------------------

describe('the acceptance page — DOCUMENT 04 A4', () => {
  it('names the company and the employee without redeeming the token', async () => {
    const token = tokenFrom(mail.lastTo(MONA.email));

    const preview = await anonymous().post('/auth/invitation-preview').send({ token });
    expect(preview.status).toBe(200);
    expect(preview.body.data).toEqual({
      company_name: 'company-a',
      employee_name: 'Mona Saleh',
    });

    // Asking twice is still not redeeming: the token has to survive the page
    // being reloaded, and it has to survive this test so the exit-criterion
    // suite below can still spend it.
    expect((await anonymous().post('/auth/invitation-preview').send({ token })).status).toBe(200);
    const invitation = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.invitation.findFirstOrThrow({ where: { user: { email: MONA.email } } }),
    );
    expect(invitation.acceptedAt).toBeNull();
  });

  it('shows nothing but those two names — an unredeemed token is a bearer credential', async () => {
    const token = tokenFrom(mail.lastTo(MONA.email));
    const preview = await anonymous().post('/auth/invitation-preview').send({ token });
    expect(Object.keys(preview.body.data as Record<string, unknown>).sort()).toEqual([
      'company_name',
      'employee_name',
    ]);
    expect(JSON.stringify(preview.body)).not.toMatch(/password|token|salary|@/i);
  });

  it('answers an unknown token exactly as a redemption would, saying no more', async () => {
    const response = await anonymous()
      .post('/auth/invitation-preview')
      .send({ token: 'not-a-real-invitation-token' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('refuses an activation that does not accept the terms', async () => {
    const token = tokenFrom(mail.lastTo(MONA.email));

    const unchecked = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token, password: MONA.password, accept_terms: false });
    expect(unchecked.status).toBe(422);
    expect(unchecked.body.error.fields).toHaveProperty('accept_terms');

    const missing = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token, password: MONA.password });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toHaveProperty('accept_terms');

    // Refused on the terms, the account is untouched and the token unspent —
    // the invitee can tick the box and carry on.
    const user = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirstOrThrow({ where: { email: MONA.email } }),
    );
    expect(user.status).toBe('invited');
    expect(user.passwordHash).toBeNull();
    expect((await anonymous().post('/auth/invitation-preview').send({ token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// FLOW 03 — the exit criterion's "invited, and manage their own login"
// ---------------------------------------------------------------------------

describe('invitation → own login — DOCUMENT 25 Phase 5 exit criterion', () => {
  it('redeems the emailed token, signs in, reads its own employee record, and changes its own password', async () => {
    const token = tokenFrom(mail.lastTo(MONA.email));
    const accepted = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token, password: MONA.password, accept_terms: true });
    expect(accepted.status).toBe(200);

    monaToken = await tokenFor(MONA.email, MONA.password);
    const me = await as(monaToken).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.role.key).toBe('manager');
    expect(me.body.data.employee).toMatchObject({
      id: mona,
      employee_code: 'MGR-7351',
      first_name: 'Mona',
    });

    const changed = await as(monaToken)
      .post('/auth/change-password')
      .send({ currentPassword: MONA.password, newPassword: MONA.next });
    expect(changed.status).toBe(200);

    expect((await login(MONA.email, MONA.password)).status).toBe(401);
    monaToken = await tokenFor(MONA.email, MONA.next);

    const profile = await as(adminA).get(`/employees/${mona}`);
    expect(profile.body.data.account).toMatchObject({
      status: 'active',
      invitation_expires_at: null,
    });
  });

  it('refuses the same token a second time', async () => {
    const token = tokenFrom(mail.lastTo(MONA.email));
    const response = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token, password: 'another-long-password', accept_terms: true });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TOKEN_INVALID');
  });

  it('resending replaces the previous link — the old token stops working', async () => {
    const created = await as(adminA)
      .post('/employees')
      .send(
        body({
          first_name: 'Omar',
          email: OMAR.email,
          manager_id: mona,
          department_id: refsA.departmentId,
          send_invitation: true,
        }),
      );
    expect(created.status).toBe(201);
    omar = created.body.data.id as string;
    const oldToken = tokenFrom(mail.lastTo(OMAR.email));

    const resent = await as(adminA).post(`/employees/${omar}/invite`);
    expect(resent.status).toBe(200);
    expect(mail.countTo(OMAR.email)).toBe(2);
    const newToken = tokenFrom(mail.lastTo(OMAR.email));
    expect(newToken).not.toBe(oldToken);

    const withOld = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token: oldToken, password: OMAR.password, accept_terms: true });
    expect(withOld.status).toBe(400);
    const withNew = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token: newToken, password: OMAR.password, accept_terms: true });
    expect(withNew.status).toBe(200);
    omarToken = await tokenFor(OMAR.email, OMAR.password);
  });

  it('will not resend to an account that is already active (409)', async () => {
    const response = await as(adminA).post(`/employees/${mona}/invite`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ACCOUNT_ALREADY_ACTIVATED');
  });

  it('reports a refused resend as 503', async () => {
    const created = await as(adminA)
      .post('/employees')
      .send(body({ email: 'hana@a.test' }));
    mail.failing = true;
    try {
      const response = await as(adminA).post(`/employees/${created.body.data.id as string}/invite`);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('MAIL_DELIVERY_FAILED');
    } finally {
      mail.failing = false;
    }
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 09 §4 checks 3 and 4, DOCUMENT 02 §4
// ---------------------------------------------------------------------------

describe('permissions and ownership scope', () => {
  it('a MANAGER lists only the employees who report to them', async () => {
    const response = await as(monaToken).get('/employees');
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([omar]);
    expect(response.body.meta.total).toBe(1);
  });

  it('a filter cannot widen a MANAGER’s scope', async () => {
    const response = await as(monaToken).get(`/employees?manager_id=${layla}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('a MANAGER reads a report (200) but not an employee outside the team (403)', async () => {
    expect((await as(monaToken).get(`/employees/${omar}`)).status).toBe(200);
    const outside = await as(monaToken).get(`/employees/${layla}`);
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe('FORBIDDEN');
  });

  it('an EMPLOYEE lists and reads only themselves', async () => {
    const list = await as(omarToken).get('/employees');
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([omar]);
    expect((await as(omarToken).get(`/employees/${omar}`)).status).toBe(200);
    expect((await as(omarToken).get(`/employees/${mona}`)).status).toBe(403);
  });

  it.each([
    ['post', '/employees'],
    ['patch', '/employees/:id'],
    ['post', '/employees/:id/deactivate'],
    ['post', '/employees/:id/activate'],
    ['post', '/employees/:id/invite'],
  ] as const)('neither a MANAGER nor an EMPLOYEE may %s %s (403)', async (method, path) => {
    for (const token of [monaToken, omarToken]) {
      const response = await as(token)[method](path.replace(':id', omar)).send({ reason: 'x' });
      expect(response.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 26 §5 — tenancy, highest severity
// ---------------------------------------------------------------------------

describe('tenant isolation — another company’s employee is 404 on every id endpoint', () => {
  it.each([
    ['get', ''],
    ['patch', ''],
    ['post', '/deactivate'],
    ['post', '/activate'],
    ['post', '/invite'],
  ] as const)('%s /employees/{A’s id}%s as company B is 404', async (method, suffix) => {
    // PATCH gets a valid body: the whitelist runs before the tenant check, and
    // an invalid body would answer 422 without ever reaching it.
    const companyB = as(adminB);
    const response = await companyB[method](`/employees/${omar}${suffix}`).send(
      method === 'patch' ? { first_name: 'Probe' } : { reason: 'probe' },
    );
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('a list never includes another company’s employees', async () => {
    const response = await as(adminB).get('/employees?per_page=100');
    const ids = response.body.data.map((row: { id: string }) => row.id);
    expect(ids).toContain(employeeB);
    expect(ids).not.toContain(omar);
    expect(ids).not.toContain(mona);
  });

  it('an unknown id is 404 and a malformed one is 400', async () => {
    expect((await as(adminA).get(`/employees/${UNKNOWN_ID}`)).status).toBe(404);
    expect((await as(adminA).get('/employees/not-a-uuid')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 21 "UI" — the employee history panel's endpoint
// ---------------------------------------------------------------------------

describe('employee history — GET /audit-logs/entity/employee/{id}', () => {
  it('returns this employee record’s own trail, and nothing else', async () => {
    const response = await as(adminA).get(`/audit-logs/entity/employee/${omar}`);
    expect(response.status).toBe(200);
    const entries = response.body.data as {
      action: string;
      entity_type: string;
      entity_id: string;
    }[];
    expect(entries.map((entry) => entry.action)).toContain('employee.created');
    for (const entry of entries) {
      expect(entry.entity_type).toBe('employee');
      expect(entry.entity_id).toBe(omar);
    }
  });

  it('requires audit.view — a MANAGER and an EMPLOYEE are refused, even for themselves', async () => {
    expect((await as(monaToken).get(`/audit-logs/entity/employee/${omar}`)).status).toBe(403);
    expect((await as(omarToken).get(`/audit-logs/entity/employee/${omar}`)).status).toBe(403);
  });

  it('shows another company nothing about this employee', async () => {
    const response = await as(adminB).get(`/audit-logs/entity/employee/${omar}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manager assignment — DOCUMENT 06 §3.6 cycle prevention
// ---------------------------------------------------------------------------

describe('manager assignment and cycle prevention', () => {
  it('refuses an employee as their own manager', async () => {
    const response = await as(adminA).patch(`/employees/${omar}`).send({ manager_id: omar });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ manager_id: ['would_create_cycle'] });
  });

  it('refuses a two-step cycle (Omar reports to Mona)', async () => {
    const response = await as(adminA).patch(`/employees/${mona}`).send({ manager_id: omar });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ manager_id: ['would_create_cycle'] });
  });

  it('accepts a valid change and audits it with old and new values', async () => {
    const response = await as(adminA).patch(`/employees/${layla}`).send({ manager_id: omar });
    expect(response.status).toBe(200);
    expect(response.body.data.manager).toMatchObject({ id: omar });

    const [record] = await audits(COMPANY_A, layla, 'EMPLOYEE_MANAGER_CHANGED');
    expect(record?.oldValues).toEqual({ manager_id: null });
    expect(record?.newValues).toEqual({ manager_id: omar });
  });

  it('refuses a longer cycle (Layla → Omar → Mona)', async () => {
    const response = await as(adminA).patch(`/employees/${mona}`).send({ manager_id: layla });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ manager_id: ['would_create_cycle'] });
  });

  it('refuses a manager from another company as not_found', async () => {
    const response = await as(adminA).patch(`/employees/${layla}`).send({ manager_id: employeeB });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ manager_id: ['not_found'] });
  });
});

// ---------------------------------------------------------------------------
// Updates and DOCUMENT 21 audit
// ---------------------------------------------------------------------------

describe('PATCH /employees/{id} — only changed fields, each action audited', () => {
  it('audits a general change with only the fields that changed', async () => {
    // Layla was created with this first name; "Laila" is a real change.
    const response = await as(adminA)
      .patch(`/employees/${layla}`)
      .send({ first_name: 'Laila', phone: '+20 100 000 0001' });
    expect(response.status).toBe(200);

    const records = await audits(COMPANY_A, layla, 'EMPLOYEE_UPDATED');
    const last = records[records.length - 1];
    expect(Object.keys(last?.newValues as object).sort()).toEqual(['first_name', 'phone']);
    expect(await audits(COMPANY_A, layla, 'EMPLOYEE_DEPARTMENT_CHANGED')).toHaveLength(0);
  });

  it('audits a department change as its own action', async () => {
    const response = await as(adminA)
      .patch(`/employees/${layla}`)
      .send({ department_id: refsA.otherDepartmentId });
    expect(response.status).toBe(200);
    const [record] = await audits(COMPANY_A, layla, 'EMPLOYEE_DEPARTMENT_CHANGED');
    expect(record?.newValues).toEqual({ department_id: refsA.otherDepartmentId });
  });

  it('writes no audit record for a PATCH that changes nothing', async () => {
    const before = await auditCount(COMPANY_A);
    const response = await as(adminA).patch(`/employees/${layla}`).send({ first_name: 'Laila' });
    expect(response.status).toBe(200);
    expect(await auditCount(COMPANY_A)).toBe(before);
  });

  it('refuses null for a required field, and unknown fields', async () => {
    expect((await as(adminA).patch(`/employees/${layla}`).send({ first_name: null })).status).toBe(
      422,
    );
    expect(
      (await as(adminA).patch(`/employees/${layla}`).send({ status: 'terminated' })).status,
    ).toBe(422);
  });

  it('keeps the login email in step with the employee email', async () => {
    const response = await as(adminA)
      .patch(`/employees/${omar}`)
      .send({ email: 'omar.new@a.test' });
    expect(response.status).toBe(200);
    OMAR.email = 'omar.new@a.test';
    omarToken = await tokenFor(OMAR.email, OMAR.password);
  });

  it('applies a role change at once: sessions are revoked, and both are audited', async () => {
    const response = await as(adminA).patch(`/employees/${omar}`).send({ role_key: 'manager' });
    expect(response.status).toBe(200);
    expect(response.body.data.account.role_key).toBe('manager');

    expect((await as(omarToken).get('/auth/me')).status).toBe(401);

    const [roleChanged] = await audits(COMPANY_A, omar, 'EMPLOYEE_ROLE_CHANGED');
    expect(roleChanged?.oldValues).toEqual({ role_key: 'employee' });
    expect(roleChanged?.newValues).toEqual({ role_key: 'manager' });

    omarToken = await tokenFor(OMAR.email, OMAR.password);
    const me = await as(omarToken).get('/auth/me');
    expect(me.body.data.role.key).toBe('manager');
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 09 §6 — deactivation and reactivation
// ---------------------------------------------------------------------------

describe('deactivation and activation', () => {
  it('requires a reason', async () => {
    const response = await as(adminA).post(`/employees/${omar}/deactivate`).send({});
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('reason');
  });

  it('deactivates, revokes every session, blocks sign-in, and keeps the reason in the audit trail', async () => {
    const response = await as(adminA)
      .post(`/employees/${omar}/deactivate`)
      .send({ reason: 'Extended unpaid absence' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'inactive',
      account: { status: 'deactivated' },
    });

    expect((await as(omarToken).get('/auth/me')).status).toBe(401);
    const signIn = await login(OMAR.email, OMAR.password);
    expect(signIn.status).toBe(401);
    expect(signIn.body.error.code).toBe('ACCOUNT_DEACTIVATED');

    const [record] = await audits(COMPANY_A, omar, 'EMPLOYEE_DEACTIVATED');
    expect(record?.newValues).toMatchObject({
      status: 'inactive',
      reason: 'Extended unpaid absence',
    });
  });

  it('refuses to deactivate twice, and to invite a deactivated employee', async () => {
    const again = await as(adminA).post(`/employees/${omar}/deactivate`).send({ reason: 'again' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('EMPLOYEE_ALREADY_INACTIVE');

    const invite = await as(adminA).post(`/employees/${omar}/invite`);
    expect(invite.status).toBe(409);
    expect(invite.body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');
  });

  it('reactivates an account that already has a password without sending a new invitation', async () => {
    const sentBefore = mail.countTo(OMAR.email);
    const response = await as(adminA).post(`/employees/${omar}/activate`);
    expect(response.status).toBe(200);
    expect(response.body.meta.invitation_delivery).toBe('not_requested');
    expect(response.body.data).toMatchObject({ status: 'active', account: { status: 'active' } });
    expect(mail.countTo(OMAR.email)).toBe(sentBefore);
    omarToken = await tokenFor(OMAR.email, OMAR.password);
    expect(await audits(COMPANY_A, omar, 'EMPLOYEE_ACTIVATED')).toHaveLength(1);
  });

  it('refuses to activate an employee who is already active', async () => {
    const response = await as(adminA).post(`/employees/${omar}/activate`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('EMPLOYEE_ALREADY_ACTIVE');
  });

  it('kills an unaccepted invitation on deactivation, and issues a fresh one on activation', async () => {
    const created = await as(adminA)
      .post('/employees')
      .send(body({ email: 'sami@a.test', send_invitation: true }));
    const sami = created.body.data.id as string;
    const staleToken = tokenFrom(mail.lastTo('sami@a.test'));

    await as(adminA).post(`/employees/${sami}/deactivate`).send({ reason: 'Offer withdrawn' });
    const withStale = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token: staleToken, password: 'sami-long-password-2026', accept_terms: true });
    expect(withStale.status).toBe(400);

    const activated = await as(adminA).post(`/employees/${sami}/activate`);
    expect(activated.status).toBe(200);
    expect(activated.body.meta.invitation_delivery).toBe('sent');
    expect(activated.body.data.account.status).toBe('invited');

    const freshToken = tokenFrom(mail.lastTo('sami@a.test'));
    const withFresh = await anonymous()
      .post('/auth/accept-invitation')
      .send({ token: freshToken, password: 'sami-long-password-2026', accept_terms: true });
    expect(withFresh.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 02 §7, DOCUMENT 09 §6 — the last-admin guard (exit criterion)
// ---------------------------------------------------------------------------

describe('the last active ADMIN cannot be demoted or deactivated', () => {
  it('refuses the only active admin demoting themselves', async () => {
    const response = await as(adminC)
      .patch(`/employees/${adminCEmployeeId}`)
      .send({ role_key: 'manager' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LAST_ACTIVE_ADMIN');
    const profile = await as(adminC).get(`/employees/${adminCEmployeeId}`);
    expect(profile.body.data.account.role_key).toBe('admin');
  });

  it('refuses the only active admin deactivating themselves', async () => {
    const response = await as(adminC)
      .post(`/employees/${adminCEmployeeId}/deactivate`)
      .send({ reason: 'Leaving' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LAST_ACTIVE_ADMIN');
    expect((await as(adminC).get('/auth/me')).status).toBe(200);
  });

  it('does not count an admin who has not accepted their invitation', async () => {
    const schedule = await as(adminC).get('/work-schedules');
    const created = await as(adminC)
      .post('/employees')
      .send({
        first_name: 'Second',
        last_name: 'Admin',
        email: 'second@c.test',
        employee_code: 'C-002',
        work_schedule_id: schedule.body.data[0].id as string,
        joining_date: '2026-03-01',
        role_key: 'admin',
        send_invitation: true,
      });
    expect(created.status).toBe(201);

    const response = await as(adminC)
      .patch(`/employees/${adminCEmployeeId}`)
      .send({ role_key: 'manager' });
    expect(response.status).toBe(409);
  });

  it('allows the demotion once a second admin is active, and ends the demoted admin’s sessions', async () => {
    const token = tokenFrom(mail.lastTo('second@c.test'));
    expect(
      (
        await anonymous()
          .post('/auth/accept-invitation')
          .send({ token, password: 'second-admin-password-2026', accept_terms: true })
      ).status,
    ).toBe(200);

    const response = await as(adminC)
      .patch(`/employees/${adminCEmployeeId}`)
      .send({ role_key: 'manager' });
    expect(response.status).toBe(200);
    expect(response.body.data.account.role_key).toBe('manager');
    expect((await as(adminC).get('/auth/me')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /employees — DOCUMENT 08 §4.3 filters, search, sort; DOCUMENT 08 §1 paging
// ---------------------------------------------------------------------------

describe('GET /employees — filters, search, sort, pagination', () => {
  it('searches by code, name and email', async () => {
    for (const term of ['MGR-7351', 'mona', 'mona@a']) {
      const response = await as(adminA).get(`/employees?search=${encodeURIComponent(term)}`);
      expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([mona]);
    }
  });

  it('normalises Arabic-Indic digits in a search', async () => {
    const response = await as(adminA).get(`/employees?search=${encodeURIComponent('MGR-٧٣٥١')}`);
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([mona]);
  });

  it('filters by department and status', async () => {
    const byDepartment = await as(adminA).get(
      `/employees?department_id=${refsA.departmentId}&per_page=100`,
    );
    expect(byDepartment.body.data.length).toBeGreaterThan(0);
    for (const row of byDepartment.body.data as { department: { id: string } }[]) {
      expect(row.department.id).toBe(refsA.departmentId);
    }
    const inactive = await as(adminA).get('/employees?status=inactive&per_page=100');
    for (const row of inactive.body.data as { status: string }[]) {
      expect(row.status).toBe('inactive');
    }
  });

  it('sorts by joining date descending', async () => {
    const response = await as(adminA).get('/employees?sort=joining_date&order=desc&per_page=100');
    const dates = (response.body.data as { joining_date: string }[]).map((row) => row.joining_date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('rejects a sort key outside the whitelist and a page size above 100', async () => {
    const sort = await as(adminA).get('/employees?sort=salary');
    expect(sort.status).toBe(422);
    expect(sort.body.error.fields).toHaveProperty('sort');
    expect((await as(adminA).get('/employees?per_page=101')).status).toBe(422);
    expect((await as(adminA).get('/employees?status=fired')).status).toBe(422);
  });

  it('pages without overlap, with a consistent total', async () => {
    const first = await as(adminA).get('/employees?per_page=2&page=1');
    const second = await as(adminA).get('/employees?per_page=2&page=2');
    expect(first.body.meta.total).toBe(second.body.meta.total);
    expect(first.body.meta.total_pages).toBe(Math.ceil((first.body.meta.total as number) / 2));
    const firstIds = (first.body.data as { id: string }[]).map((row) => row.id);
    for (const row of second.body.data as { id: string }[]) {
      expect(firstIds).not.toContain(row.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Departments, now that employees exist — DOCUMENT 06 §3.4
// ---------------------------------------------------------------------------

describe('departments and employees', () => {
  it('blocks removing a department while active employees are assigned to it (409)', async () => {
    const response = await as(adminA).delete(`/departments/${refsA.departmentId}`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DEPARTMENT_HAS_EMPLOYEES');
  });

  it('records a department manager from the same company', async () => {
    const response = await as(adminA)
      .patch(`/departments/${refsA.departmentId}`)
      .send({ manager_employee_id: mona });
    expect(response.status).toBe(200);
    expect(response.body.data.manager_employee_id).toBe(mona);
  });

  it('refuses another company’s employee as a department manager', async () => {
    const response = await as(adminA)
      .patch(`/departments/${refsA.departmentId}`)
      .send({ manager_employee_id: employeeB });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ manager_employee_id: ['not_found'] });
  });
});
