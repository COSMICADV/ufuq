/**
 * Phase 11 end-to-end — DOCUMENT 25 Phase 11, DOCUMENT 15, DOCUMENT 08 §4.10
 * and §8, DOCUMENT 26 (payroll: generation, finalization, idempotency,
 * permissions), OD-06 B, OD-07 A, OD-08 A.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security under `ufuq_app`, and the real triggers that make finalized payroll
 * immutable. Redis, mail, object storage, the audit retry queue and the event
 * sinks are fakes.
 *
 * `Date` is fixed at Friday 2026-04-10, 10:00 Cairo, so March 2026 has ended
 * and April has not. The schedule works Sunday–Thursday, 09:00–17:00 with a
 * 60-minute break (420 minutes). March 2026 has 23 working days.
 *
 * The policy under test (set over HTTP): fixed_days 30, absence = daily wage,
 * unpaid leave = daily wage, lateness per minute × 1.00, overtime × 1.50,
 * rounding none. Every monetary assertion is an exact string.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { AuditAction, PrismaClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import { AUDIT_RETRY_QUEUE } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import type { AuthContext } from '../src/auth/auth-context.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { LEAVE_EVENT_SINK } from '../src/leave/leave-events.js';
import type { LeaveEvent, LeaveEventSink } from '../src/leave/leave-events.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import { PAYROLL_EVENT_SINK } from '../src/payroll/payroll-events.js';
import type { PayrollEvent, PayrollEventSink } from '../src/payroll/payroll-events.js';
import { PayrollService } from '../src/payroll/payroll.service.js';

import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
import { allMigrationsSql } from './all-migrations.js';

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let prisma: PrismaClient;

const redis = new FakeRedis();
const storage = new InMemoryObjectStorage();

class CapturingMail implements MailTransport {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
const mail = new CapturingMail();

class CapturingPayrollSink implements PayrollEventSink {
  readonly events: PayrollEvent[] = [];
  handle(event: PayrollEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
const payrollSink = new CapturingPayrollSink();

class NullLeaveSink implements LeaveEventSink {
  handle(_event: LeaveEvent): Promise<void> {
    return Promise.resolve();
  }
}

class CapturingRetryQueue implements AuditRetryQueue {
  readonly entries: QueuedAuditEntry[] = [];
  enqueue(entry: QueuedAuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
const retryQueue = new CapturingRetryQueue();

const COMPANY_A = generateId();
const COMPANY_B = generateId();

const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };
const ADMIN_EMP = { email: 'admin-emp@a.test', password: 'admin-emp-password-2026' };
const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };
const WORKER2 = { email: 'worker2@a.test', password: 'worker2-password-2026' };
const WORKER_B = { email: 'worker@b.test', password: 'worker-b-password-2026' };

const ids = {
  adminEmp: '',
  manager: '',
  worker: '',
  worker2: '',
  newcomer: '',
  workerB: '',
  scheduleA: '',
};

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

/** Friday 2026-04-10, 10:00 in Cairo (UTC+2). */
const NOW = new Date(Date.UTC(2026, 3, 10, 8, 0, 0));

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

function week(): unknown[] {
  return Array.from({ length: 7 }, (_, day) =>
    day <= 4
      ? { day_of_week: day, is_working_day: true, start_time: '09:00', end_time: '17:00' }
      : { day_of_week: day, is_working_day: false },
  );
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
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({ data: { id: companyId, name: slug, slug, timezone: CAIRO } });
      await tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: admin.email,
          passwordHash,
          roleId: adminRoleId,
          status: 'active',
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

interface Account {
  readonly email: string;
  readonly password: string;
}

const tokens = new Map<string, string>();

function as(token: string) {
  const agent = request(server());
  const auth = <T extends { set: (key: string, value: string) => T }>(builder: T): T =>
    builder.set('Authorization', `Bearer ${token}`);
  return {
    get: (path: string) => auth(agent.get(`/${API_PREFIX}${path}`)),
    post: (path: string) => auth(agent.post(`/${API_PREFIX}${path}`)),
    patch: (path: string) => auth(agent.patch(`/${API_PREFIX}${path}`)),
  };
}

async function api(account: Account) {
  let token = tokens.get(account.email);
  if (token === undefined) {
    redis.reset();
    const response = await request(server())
      .post(`/${API_PREFIX}/auth/login`)
      .set('X-Client-Type', 'mobile')
      .send({ email: account.email, password: account.password });
    if (response.status !== 200) {
      throw new Error(`Login failed for ${account.email}: ${JSON.stringify(response.body)}`);
    }
    token = response.body.data.accessToken as string;
    tokens.set(account.email, token);
  }
  return as(token);
}

async function createEmployee(account: Account, body: Record<string, unknown>): Promise<string> {
  const response = await (await api(account))
    .post('/employees')
    .send({ joining_date: '2026-01-05', send_invitation: true, ...body });
  if (response.status !== 201) {
    throw new Error(`Employee create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as string;
}

async function activate(account: Account): Promise<void> {
  const message = [...mail.sent].reverse().find((m) => m.to === account.email);
  if (!message) throw new Error(`No invitation for ${account.email}`);
  const token = /#token=([^\s"']+)/.exec(message.text)?.[1];
  if (token === undefined) throw new Error(`No token in the invitation for ${account.email}`);
  const accepted = await request(server())
    .post(`/${API_PREFIX}/auth/accept-invitation`)
    .send({ token: decodeURIComponent(token), password: account.password, accept_terms: true });
  if (accepted.status !== 200) {
    throw new Error(`Activation failed: ${JSON.stringify(accepted.body)}`);
  }
}

async function asOwner<T>(run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('RESET ROLE');
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
  }
}

async function withFailingTrigger(
  table: string,
  condition: string,
  run: () => Promise<void>,
): Promise<void> {
  await asOwner(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_force_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_force_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_force_failure()`,
    );
  });
  try {
    await run();
  } finally {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`DROP TRIGGER test_force_failure ON ${table}`);
      await prisma.$executeRawUnsafe('DROP FUNCTION test_force_failure()');
    });
  }
}

async function audits(action: AuditAction, entityId?: string) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({
      where: { action, ...(entityId === undefined ? {} : { entityId }) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
}

async function periodCount(): Promise<number> {
  return withTenant(prisma, COMPANY_A, (tx) => tx.payrollPeriod.count());
}

async function lineCount(): Promise<number> {
  return withTenant(prisma, COMPANY_A, (tx) => tx.payrollLine.count());
}

/** Every Sunday–Thursday of March 2026, as `YYYY-MM-DD`. */
const MARCH_WORKING_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)
  .filter((day) => new Date(Date.UTC(2026, 2, day)).getUTCDay() <= 4)
  .map((day) => `2026-03-${String(day).padStart(2, '0')}`);

interface DayOverride {
  readonly status?: 'present' | 'late' | 'absent' | 'pending';
  readonly lateMinutes?: number;
  readonly overtimeMinutes?: number;
  readonly wfh?: boolean;
  readonly none?: boolean;
}

/** One attendance row per March working day, present unless overridden. */
async function seedMarch(
  employeeId: string,
  overrides: Readonly<Record<string, DayOverride>> = {},
  from = '2026-03-01',
): Promise<void> {
  const rows = MARCH_WORKING_DAYS.filter((date) => date >= from)
    .filter((date) => overrides[date]?.none !== true)
    .map((date) => {
      const o = overrides[date] ?? {};
      const status = o.status ?? 'present';
      const worked = status !== 'absent';
      const checkIn = new Date(`${date}T07:00:00.000Z`);
      return {
        id: generateId(),
        companyId: COMPANY_A,
        employeeId,
        date: new Date(`${date}T00:00:00.000Z`),
        status,
        source: 'self' as const,
        workMode: worked ? (o.wfh === true ? ('wfh' as const) : ('office' as const)) : null,
        checkInAt: worked ? checkIn : null,
        checkOutAt: worked && status !== 'pending' ? new Date(`${date}T15:00:00.000Z`) : null,
        workingMinutes: worked && status !== 'pending' ? 420 : null,
        lateMinutes: o.lateMinutes ?? 0,
        overtimeMinutes: o.overtimeMinutes ?? 0,
      };
    });
  await withTenant(prisma, COMPANY_A, (tx) => tx.attendanceRecord.createMany({ data: rows }));
}

interface Line {
  readonly id: string;
  readonly employee: { id: string; code: string };
  readonly base_salary: string;
  readonly daily_wage: string;
  readonly working_days: number;
  readonly present_days: number;
  readonly wfh_days: number;
  readonly absent_days: number;
  readonly unpaid_leave_days: number;
  readonly late_minutes_total: number;
  readonly attendance_adjustment: string;
  readonly total_deductions: string;
  readonly total_bonuses: string;
  readonly net_salary: string;
  readonly adjusted_net: string;
  readonly adjustments_total: string;
  readonly status: string;
  readonly review_reasons: string[];
  readonly is_locked: boolean;
}

interface Period {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly employee_count: number;
  readonly total_gross: string;
  readonly total_attendance_adjustment: string;
  readonly total_deductions: string;
  readonly total_bonuses: string;
  readonly total_net: string;
  readonly paid_at: string | null;
  readonly abilities: Record<string, boolean>;
  readonly lines: Line[];
}

let periodId = '';

async function period(): Promise<Period> {
  const response = await (await api(ADMIN_A)).get(`/payroll/periods/${periodId}`);
  expect(response.status).toBe(200);
  return response.body.data as Period;
}

async function lineOf(employeeId: string): Promise<Line> {
  const found = (await period()).lines.find((line) => line.employee.id === employeeId);
  if (found === undefined) throw new Error(`No line for ${employeeId}`);
  return found;
}

function sum(values: readonly string[]): string {
  return Decimal.sum(
    values.map((v) => Decimal.parse(v, 2)),
    2,
  ).toString();
}

function expectTotalsEqualLines(p: Period): void {
  expect(p.employee_count).toBe(p.lines.length);
  expect(p.total_gross).toBe(sum(p.lines.map((l) => l.base_salary)));
  expect(p.total_attendance_adjustment).toBe(sum(p.lines.map((l) => l.attendance_adjustment)));
  expect(p.total_deductions).toBe(sum(p.lines.map((l) => l.total_deductions)));
  expect(p.total_bonuses).toBe(sum(p.lines.map((l) => l.total_bonuses)));
  expect(p.total_net).toBe(sum(p.lines.map((l) => l.net_salary)));
}

const POLICY = {
  name: 'Standard',
  daily_wage_basis: 'fixed_days',
  fixed_days_value: 30,
  unpaid_leave_deduction: 'daily_wage',
  absence_deduction: 'daily_wage',
  lateness_rule: { type: 'per_minute', multiplier: '1.00' },
  overtime_rate: '1.50',
  rounding: 'none',
};

let managerLeaveId = '';
let adminEmpLeaveId = '';

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .overrideProvider(LEAVE_EVENT_SINK)
    .useValue(new NullLeaveSink())
    .overrideProvider(PAYROLL_EVENT_SINK)
    .useValue(payrollSink)
    .overrideProvider(AUDIT_RETRY_QUEUE)
    .useValue(retryQueue)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');

  prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures();
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  const schedule = await (await api(ADMIN_A)).post('/work-schedules').send({
    name: 'Standard week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  ids.scheduleA = schedule.body.data.id as string;

  ids.adminEmp = await createEmployee(ADMIN_A, {
    first_name: 'Hala',
    last_name: 'Kamal',
    email: ADMIN_EMP.email,
    employee_code: 'ADM-1',
    role_key: 'admin',
    work_schedule_id: ids.scheduleA,
  });
  ids.manager = await createEmployee(ADMIN_A, {
    first_name: 'Mona',
    last_name: 'Saleh',
    email: MANAGER.email,
    employee_code: 'MGR-1',
    role_key: 'manager',
    work_schedule_id: ids.scheduleA,
  });
  ids.worker = await createEmployee(ADMIN_A, {
    first_name: 'Omar',
    last_name: 'Fathy',
    email: WORKER.email,
    employee_code: 'EMP-1',
    role_key: 'employee',
    manager_id: ids.manager,
    work_schedule_id: ids.scheduleA,
  });
  ids.worker2 = await createEmployee(ADMIN_A, {
    first_name: 'Sara',
    last_name: 'Adel',
    email: WORKER2.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    manager_id: ids.manager,
    work_schedule_id: ids.scheduleA,
  });
  ids.newcomer = await createEmployee(ADMIN_A, {
    first_name: 'Nour',
    last_name: 'Hassan',
    email: 'newcomer@a.test',
    employee_code: 'EMP-3',
    role_key: 'employee',
    work_schedule_id: ids.scheduleA,
    joining_date: '2026-03-16',
  });
  for (const account of [ADMIN_EMP, MANAGER, WORKER, WORKER2]) {
    await activate(account);
  }

  const scheduleB = await (await api(ADMIN_B)).post('/work-schedules').send({
    name: 'B week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  ids.workerB = await createEmployee(ADMIN_B, {
    first_name: 'Other',
    last_name: 'Person',
    email: WORKER_B.email,
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB.body.data.id as string,
  });
  await activate(WORKER_B);

  // March attendance. Omar: absent on 2 March, 30 minutes late on 17 March.
  // Sara: one open (pending) day on 4 March. Nour joins 16 March. Hala takes
  // two unpaid days, approved before payroll. Mona has no record on 31 March
  // and a pending unpaid leave request for it.
  await seedMarch(ids.worker, {
    '2026-03-02': { status: 'absent' },
    '2026-03-17': { status: 'late', lateMinutes: 30 },
  });
  await seedMarch(ids.worker2, { '2026-03-04': { status: 'pending' } });
  await seedMarch(ids.newcomer, {}, '2026-03-16');
  await seedMarch(ids.adminEmp, { '2026-03-29': { none: true }, '2026-03-30': { none: true } });
  await seedMarch(ids.manager, { '2026-03-31': { none: true } });

  const types = (await (await api(ADMIN_A)).get('/leave-types')).body.data as {
    id: string;
    name_en: string;
  }[];
  const unpaid = types.find((t) => t.name_en === 'Unpaid')?.id as string;
  const adminLeave = await (await api(ADMIN_EMP)).post('/leave-requests').send({
    leave_type_id: unpaid,
    start_date: '2026-03-29',
    end_date: '2026-03-30',
    reason: 'Family matters',
  });
  expect(adminLeave.status).toBe(201);
  adminEmpLeaveId = adminLeave.body.data.id as string;
  expect(
    (await (await api(ADMIN_A)).post(`/leave-requests/${adminEmpLeaveId}/approve`).send({})).status,
  ).toBe(200);
  const managerLeave = await (await api(MANAGER)).post('/leave-requests').send({
    leave_type_id: unpaid,
    start_date: '2026-03-31',
    end_date: '2026-03-31',
    reason: 'Appointment',
  });
  expect(managerLeave.status).toBe(201);
  managerLeaveId = managerLeave.body.data.id as string;
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await socket.stop();
  await pglite.close();
});

beforeEach(() => {
  payrollSink.events.length = 0;
});

// ---------------------------------------------------------------------------
// Access — OD-07 A, DOCUMENT 26 §5
// ---------------------------------------------------------------------------

describe('access: MANAGER has none, EMPLOYEE only their own, another company 404', () => {
  it('401 without a session', async () => {
    const response = await request(server()).get(`/${API_PREFIX}/payroll/periods`);
    expect(response.status).toBe(401);
  });

  it('a MANAGER cannot reach payroll, salary or the salary policy', async () => {
    const manager = await api(MANAGER);
    for (const path of [
      '/payroll/periods',
      '/payroll/me',
      '/payroll/me/history',
      '/payroll/lines',
      `/employees/${ids.worker}/salary`,
      `/employees/${ids.manager}/salary`,
      '/salary-policies',
    ]) {
      expect((await manager.get(path)).status, path).toBe(403);
    }
    expect((await manager.post('/payroll/periods').send({ year: 2026, month: 3 })).status).toBe(
      403,
    );
    expect((await manager.patch('/salary-policies').send(POLICY)).status).toBe(403);
  });

  it('an EMPLOYEE cannot read company payroll or change anything', async () => {
    const worker = await api(WORKER);
    expect((await worker.get('/payroll/periods')).status).toBe(403);
    expect((await worker.post('/payroll/periods').send({ year: 2026, month: 3 })).status).toBe(403);
    expect((await worker.patch('/salary-policies').send(POLICY)).status).toBe(403);
    expect(
      (
        await worker.post(`/employees/${ids.worker}/salary`).send({
          monthly_salary: '99999.00',
          effective_from: '2026-04-01',
        })
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Salary policy — DOCUMENT 06 §3.22, approved decision: no default
// ---------------------------------------------------------------------------

describe('salary policy: configuration, never invented', () => {
  it('there is none until an ADMIN saves one; salaries are refused until then', async () => {
    const admin = await api(ADMIN_A);
    expect((await admin.get('/salary-policies')).body.data).toEqual({ policy: null });
    const refused = await admin
      .post(`/employees/${ids.worker}/salary`)
      .send({ monthly_salary: '20000.00', effective_from: '2026-01-05' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('SALARY_POLICY_NOT_CONFIGURED');
  });

  it('the first save must state every rule', async () => {
    const response = await (await api(ADMIN_A))
      .patch('/salary-policies')
      .send({ daily_wage_basis: 'calendar_days' });
    expect(response.status).toBe(422);
    expect(Object.keys(response.body.error.fields).sort()).toEqual(
      [
        'absence_deduction',
        'lateness_rule',
        'name',
        'overtime_rate',
        'rounding',
        'unpaid_leave_deduction',
      ].sort(),
    );
  });

  it('validates the configuration server-side', async () => {
    const admin = await api(ADMIN_A);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...POLICY, fixed_days_value: undefined }, 'fixed_days_value'],
      [{ ...POLICY, daily_wage_basis: 'calendar_days', fixed_days_value: 30 }, 'fixed_days_value'],
      [{ ...POLICY, lateness_rule: { type: 'tiered' } }, 'lateness_rule'],
      [{ ...POLICY, lateness_rule: { type: 'per_minute' } }, 'lateness_rule'],
      [{ ...POLICY, lateness_rule: { type: 'none', extra: '1' } }, 'lateness_rule'],
      [{ ...POLICY, overtime_rate: 1.5 }, 'overtime_rate'],
      [{ ...POLICY, overtime_rate: '-1.00' }, 'overtime_rate'],
      [{ ...POLICY, rounding: 'bankers' }, 'rounding'],
    ];
    for (const [body, field] of cases) {
      const response = await admin.patch('/salary-policies').send(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(Object.keys(response.body.error.fields)).toContain(field);
    }
    expect((await admin.patch('/salary-policies').send({ ...POLICY, surprise: 1 })).status).toBe(
      422,
    );
    expect((await admin.get('/salary-policies')).body.data.policy).toBeNull();
  });

  it('saves, reads back exactly, and is audited', async () => {
    const admin = await api(ADMIN_A);
    const saved = await admin.patch('/salary-policies').send(POLICY);
    expect(saved.status).toBe(200);
    expect(saved.body.data.policy).toMatchObject({
      daily_wage_basis: 'fixed_days',
      fixed_days_value: 30,
      lateness_rule: { type: 'per_minute', multiplier: '1.00' },
      overtime_rate: '1.50',
      rounding: 'none',
    });
    expect(await audits('SALARY_POLICY_CHANGED')).toHaveLength(1);
    // A partial later save changes only what it names.
    const renamed = await admin.patch('/salary-policies').send({ name: 'Standard 2026' });
    expect(renamed.body.data.policy).toMatchObject({ name: 'Standard 2026', fixed_days_value: 30 });
    const changes = await audits('SALARY_POLICY_CHANGED');
    expect(changes[1]?.newValues).toEqual({ name: 'Standard 2026' });
  });
});

// ---------------------------------------------------------------------------
// Salary history — DOCUMENT 06 §3.21, DOCUMENT 15 rule 8
// ---------------------------------------------------------------------------

describe('salary history: closed and appended, never rewritten', () => {
  it('sets, then changes mid-month: the old row is closed, its amount untouched', async () => {
    const admin = await api(ADMIN_A);
    const first = await admin
      .post(`/employees/${ids.worker}/salary`)
      .send({ monthly_salary: '20000.00', effective_from: '2026-01-05' });
    expect(first.status).toBe(201);
    const second = await admin
      .post(`/employees/${ids.worker}/salary`)
      .set('Idempotency-Key', 'omar-raise')
      .send({ monthly_salary: '26000.00', effective_from: '2026-03-16', note: 'Promotion' });
    expect(second.status).toBe(201);
    expect(
      second.body.data.history.map((r: Record<string, unknown>) => [
        r.monthly_salary,
        r.effective_from,
        r.effective_to,
      ]),
    ).toEqual([
      ['26000.00', '2026-03-16', null],
      ['20000.00', '2026-01-05', '2026-03-15'],
    ]);
    expect(second.body.data.current.monthly_salary).toBe('26000.00');
    const changes = await audits('EMPLOYEE_SALARY_CHANGED', ids.worker);
    expect(changes).toHaveLength(2);
    expect(changes[1]?.oldValues).toEqual({
      monthly_salary: '20000.00',
      effective_from: '2026-01-05',
    });
    expect(changes[1]?.newValues).toMatchObject({
      monthly_salary: '26000.00',
      effective_from: '2026-03-16',
    });
  });

  it('the same Idempotency-Key replays; a different request with it is refused', async () => {
    const admin = await api(ADMIN_A);
    const again = await admin
      .post(`/employees/${ids.worker}/salary`)
      .set('Idempotency-Key', 'omar-raise')
      .send({ monthly_salary: '26000.00', effective_from: '2026-03-16', note: 'Promotion' });
    expect(again.status).toBe(201);
    expect(again.body.data.history).toHaveLength(2);
    const reused = await admin
      .post(`/employees/${ids.worker}/salary`)
      .set('Idempotency-Key', 'omar-raise')
      .send({ monthly_salary: '27000.00', effective_from: '2026-04-01' });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await audits('EMPLOYEE_SALARY_CHANGED', ids.worker)).toHaveLength(2);
  });

  it('refuses re-cutting history, a non-positive amount, a float, and dates outside employment', async () => {
    const admin = await api(ADMIN_A);
    const post = (body: Record<string, unknown>) =>
      admin.post(`/employees/${ids.worker}/salary`).send(body);
    expect(
      (await post({ monthly_salary: '25000.00', effective_from: '2026-03-16' })).body.error.fields,
    ).toEqual({
      effective_from: ['not_after_current'],
    });
    expect((await post({ monthly_salary: '0.00', effective_from: '2026-05-01' })).status).toBe(422);
    expect((await post({ monthly_salary: 25000, effective_from: '2026-05-01' })).status).toBe(422);
    expect((await post({ monthly_salary: '25000.001', effective_from: '2026-05-01' })).status).toBe(
      422,
    );
    expect(
      (
        await admin
          .post(`/employees/${ids.newcomer}/salary`)
          .send({ monthly_salary: '1.00', effective_from: '2026-03-01' })
      ).body.error.fields,
    ).toEqual({ effective_from: ['before_joining'] });
  });

  it('salaries for the rest of the company', async () => {
    const admin = await api(ADMIN_A);
    for (const [id, amount] of [
      [ids.worker2, '23000.00'],
      [ids.newcomer, '20000.00'],
      [ids.adminEmp, '30000.00'],
    ] as const) {
      const response = await admin.post(`/employees/${id}/salary`).send({
        monthly_salary: amount,
        effective_from: id === ids.newcomer ? '2026-03-16' : '2026-01-05',
      });
      expect(response.status).toBe(201);
    }
  });

  it('an EMPLOYEE reads their own salary; another’s is 404; another company’s is 404', async () => {
    const worker = await api(WORKER);
    const own = await worker.get(`/employees/${ids.worker}/salary`);
    expect(own.status).toBe(200);
    expect(own.body.data.current.monthly_salary).toBe('26000.00');
    expect((await worker.get(`/employees/${ids.worker2}/salary`)).status).toBe(404);
    expect((await (await api(ADMIN_B)).get(`/employees/${ids.worker}/salary`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Generation — DOCUMENT 15 rule 3, FLOW 14
// ---------------------------------------------------------------------------

describe('generation: pre-flight first, then all or nothing', () => {
  it('the current month has not ended', async () => {
    const response = await (await api(ADMIN_A))
      .post('/payroll/periods')
      .send({ year: 2026, month: 4 });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PAYROLL_PERIOD_NOT_ENDED');
  });

  it('an employee without a salary blocks everything, listed, and nothing is created', async () => {
    const response = await (await api(ADMIN_A))
      .post('/payroll/periods')
      .send({ year: 2026, month: 3 });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PAYROLL_PREFLIGHT_BLOCKED');
    expect(response.body.error.fields).toEqual({ [ids.manager]: ['salary_missing:2026-03-01'] });
    expect(await periodCount()).toBe(0);
    const preflight = await (
      await api(ADMIN_A)
    ).get('/payroll/periods/preflight?year=2026&month=3');
    expect(preflight.status).toBe(200);
    expect(preflight.body.data.blocking).toEqual([
      {
        employee: { id: ids.manager, code: 'MGR-1', name: 'Mona Saleh' },
        issue: 'salary_missing',
        detail: '2026-03-01',
      },
    ]);
  });

  it('incomplete attendance is a 409 listing employees and dates, unless the Admin proceeds', async () => {
    expect(
      (
        await (await api(ADMIN_A))
          .post(`/employees/${ids.manager}/salary`)
          .send({ monthly_salary: '30000.00', effective_from: '2026-01-05' })
      ).status,
    ).toBe(201);
    const response = await (await api(ADMIN_A))
      .post('/payroll/periods')
      .send({ year: 2026, month: 3 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYROLL_ATTENDANCE_INCOMPLETE');
    expect(response.body.error.fields).toEqual({
      [ids.worker2]: ['pending:2026-03-04'],
      [ids.manager]: ['missing:2026-03-31'],
    });
    expect(await periodCount()).toBe(0);
  });

  it('a failure while writing any line creates nothing — no period, no line, no audit, no event', async () => {
    await withFailingTrigger(
      'payroll_lines',
      `TG_OP = 'INSERT' AND NEW.employee_id = '${ids.worker2}'::uuid`,
      async () => {
        const response = await (await api(ADMIN_A))
          .post('/payroll/periods')
          .send({ year: 2026, month: 3, proceed_with_warnings: true });
        expect(response.status).toBe(500);
      },
    );
    expect(await periodCount()).toBe(0);
    expect(await lineCount()).toBe(0);
    expect(await audits('PAYROLL_GENERATED')).toEqual([]);
    expect(payrollSink.events).toEqual([]);
  });

  it('two concurrent generations with one Idempotency-Key: one period, the same result twice', async () => {
    const admin = await api(ADMIN_A);
    const send = () =>
      admin
        .post('/payroll/periods')
        .set('Idempotency-Key', 'march-2026')
        .send({ year: 2026, month: 3, proceed_with_warnings: true });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    periodId = a.body.data.id as string;
    expect(await periodCount()).toBe(1);
    expect(await audits('PAYROLL_GENERATED')).toHaveLength(1);
    expect(payrollSink.events.map((e) => e.type)).toEqual(['payroll_generated']);
  });

  it('a second generation without the key is a 409; the same key with another body is refused', async () => {
    const admin = await api(ADMIN_A);
    const again = await admin
      .post('/payroll/periods')
      .send({ year: 2026, month: 3, proceed_with_warnings: true });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYROLL_PERIOD_EXISTS');
    const reused = await admin
      .post('/payroll/periods')
      .set('Idempotency-Key', 'march-2026')
      .send({ year: 2026, month: 2, proceed_with_warnings: true });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await periodCount()).toBe(1);
  });

  it('calculates every line exactly, and the totals are exactly the sum of the lines', async () => {
    const p = await period();
    expect(p.status).toBe('draft');
    expect(p.label).toBe('2026-03');
    expect(p.lines).toHaveLength(5);
    expectTotalsEqualLines(p);

    // Omar: 11 days at 20,000 and 12 at 26,000; absent 2 March (666.67),
    // 30 minutes late on 17 March at 26,000 ÷ 30 ÷ 420 a minute (61.90).
    // Exact net 10820100/483 = 22401.8633…
    const omar = p.lines.find((l) => l.employee.id === ids.worker) as Line;
    expect(omar).toMatchObject({
      base_salary: '23130.43',
      daily_wage: '866.67',
      working_days: 23,
      present_days: 22,
      absent_days: 1,
      late_minutes_total: 30,
      attendance_adjustment: '-728.57',
      net_salary: '22401.86',
      status: 'calculated',
    });
    // Nour: joined 16 March — 12 of 23 working days of 20,000.
    expect(p.lines.find((l) => l.employee.id === ids.newcomer)).toMatchObject({
      base_salary: '10434.78',
      working_days: 12,
      net_salary: '10434.78',
    });
    // Sara: a full month; the pending day counts as worked and is flagged.
    expect(p.lines.find((l) => l.employee.id === ids.worker2)).toMatchObject({
      base_salary: '23000.00',
      net_salary: '23000.00',
      status: 'needs_review',
      review_reasons: ['pending_days'],
    });
    // Hala: two approved unpaid days at 30,000 ÷ 30.
    expect(p.lines.find((l) => l.employee.id === ids.adminEmp)).toMatchObject({
      unpaid_leave_days: 2,
      attendance_adjustment: '-2000.00',
      net_salary: '28000.00',
    });
    // Mona: nothing recorded on 31 March — absent (DOCUMENT 12 rule 10), listed.
    expect(p.lines.find((l) => l.employee.id === ids.manager)).toMatchObject({
      absent_days: 1,
      attendance_adjustment: '-1000.00',
      net_salary: '29000.00',
      review_reasons: ['missing_days'],
    });
    expect(p.total_net).toBe('112836.64');
  });

  it('lists with pagination, and another company sees nothing of it', async () => {
    const list = await (await api(ADMIN_A)).get('/payroll/periods?per_page=1');
    expect(list.status).toBe(200);
    expect(list.body.meta).toMatchObject({ page: 1, per_page: 1, total: 1 });
    const adminB = await api(ADMIN_B);
    expect((await adminB.get(`/payroll/periods/${periodId}`)).status).toBe(404);
    expect((await adminB.get('/payroll/periods')).body.data).toEqual([]);
    expect((await (await api(ADMIN_A)).get('/payroll/periods/not-a-uuid')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Deductions and bonuses — DOCUMENT 15 rule 6, FLOW 15, OD-06 B
// ---------------------------------------------------------------------------

describe('deductions and bonuses: append-only, reasoned, re-netting atomically', () => {
  it('adds a deduction and a bonus; the line and the period totals follow exactly', async () => {
    const sara = await lineOf(ids.worker2);
    const admin = await api(ADMIN_A);
    const deducted = await admin
      .post(`/payroll/lines/${sara.id}/deductions`)
      .set('Idempotency-Key', 'sara-laptop')
      .send({ amount: '500.00', reason: 'Laptop damage', type: 'equipment' });
    expect(deducted.status).toBe(201);
    expect(deducted.body.data).toMatchObject({
      total_deductions: '500.00',
      net_salary: '22500.00',
    });
    expect(deducted.body.data.deductions).toEqual([
      expect.objectContaining({ amount: '500.00', reason: 'Laptop damage', type: 'equipment' }),
    ]);
    expect(deducted.body.data.deductions[0].created_by.email).toBe(ADMIN_A.email);
    const bonus = await admin
      .post(`/payroll/lines/${sara.id}/bonuses`)
      .send({ amount: '250.50', reason: 'Great quarter' });
    expect(bonus.status).toBe(201);
    expect(bonus.body.data).toMatchObject({ total_bonuses: '250.50', net_salary: '22750.50' });
    const p = await period();
    expectTotalsEqualLines(p);
    expect(p.total_deductions).toBe('500.00');
    expect(p.total_bonuses).toBe('250.50');
    expect(await audits('DEDUCTION_ADDED', sara.id)).toHaveLength(1);
    expect(await audits('BONUS_ADDED', sara.id)).toHaveLength(1);
  });

  it('the same Idempotency-Key does not deduct twice', async () => {
    const sara = await lineOf(ids.worker2);
    const again = await (await api(ADMIN_A))
      .post(`/payroll/lines/${sara.id}/deductions`)
      .set('Idempotency-Key', 'sara-laptop')
      .send({ amount: '500.00', reason: 'Laptop damage', type: 'equipment' });
    expect(again.status).toBe(201);
    expect(again.body.data.deductions).toHaveLength(1);
    expect((await lineOf(ids.worker2)).net_salary).toBe('22750.50');
  });

  it('the same Idempotency-Key does not add a bonus twice', async () => {
    const nour = await lineOf(ids.newcomer);
    const admin = await api(ADMIN_A);
    const send = () =>
      admin
        .post(`/payroll/lines/${nour.id}/bonuses`)
        .set('Idempotency-Key', 'nour-welcome')
        .send({ amount: '300.00', reason: 'Welcome bonus' });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.data.bonuses).toHaveLength(1);
    expect((await lineOf(ids.newcomer)).net_salary).toBe('10734.78');
    expect(await audits('BONUS_ADDED', nour.id)).toHaveLength(1);
  });

  it('a deduction that would make the net negative is refused with the figure — never capped', async () => {
    const sara = await lineOf(ids.worker2);
    const response = await (await api(ADMIN_A))
      .post(`/payroll/lines/${sara.id}/deductions`)
      .send({ amount: '30000.00', reason: 'Loan repayment' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('PAYROLL_NEGATIVE_NET');
    expect(response.body.error.fields).toEqual({ resulting_net: ['-7249.50'] });
    expect((await lineOf(ids.worker2)).total_deductions).toBe('500.00');
  });

  it('validates amount, reason, type and unknown fields; an adjustment is not for a draft', async () => {
    const sara = await lineOf(ids.worker2);
    const admin = await api(ADMIN_A);
    const post = (body: Record<string, unknown>) =>
      admin.post(`/payroll/lines/${sara.id}/deductions`).send(body);
    for (const body of [
      { amount: '0.00', reason: 'Valid reason' },
      { amount: '-5.00', reason: 'Valid reason' },
      { amount: 5, reason: 'Valid reason' },
      { amount: '5.001', reason: 'Valid reason' },
      { amount: '5.00', reason: 'ab' },
      { amount: '5.00' },
      { amount: '5.00', reason: 'Valid reason', created_by: 'me' },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(
      (
        await admin
          .post(`/payroll/lines/${sara.id}/adjustments`)
          .send({ amount: '10.00', reason: 'Too early' })
      ).status,
    ).toBe(409);
    expect(
      (
        await admin
          .post(`/payroll/lines/${generateId()}/deductions`)
          .send({ amount: '5.00', reason: 'Valid reason' })
      ).status,
    ).toBe(404);
    expect(
      (
        await (await api(ADMIN_B))
          .post(`/payroll/lines/${sara.id}/deductions`)
          .send({ amount: '5.00', reason: 'Valid reason' })
      ).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Recalculation — DOCUMENT 15 rule 5
// ---------------------------------------------------------------------------

describe('recalculation: draft only, atomic, entries kept', () => {
  it('a forced failure leaves the previous draft exactly as it was', async () => {
    const before = await period();
    await withFailingTrigger(
      'payroll_lines',
      `TG_OP = 'UPDATE' AND NEW.employee_id = '${ids.worker}'::uuid`,
      async () => {
        const response = await (await api(ADMIN_A))
          .post(`/payroll/periods/${periodId}/recalculate`)
          .send({ proceed_with_warnings: true });
        expect(response.status).toBe(500);
      },
    );
    expect(await period()).toEqual(before);
    expect(await audits('PAYROLL_REGENERATED')).toEqual([]);
  });

  it('picks up corrected attendance and keeps the Admin’s entries', async () => {
    // Mona's missing day gets a real record.
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.create({
        data: {
          id: generateId(),
          companyId: COMPANY_A,
          employeeId: ids.manager,
          date: new Date('2026-03-31T00:00:00.000Z'),
          status: 'present',
          source: 'admin',
          workMode: 'office',
          checkInAt: new Date('2026-03-31T07:00:00.000Z'),
          checkOutAt: new Date('2026-03-31T15:00:00.000Z'),
          workingMinutes: 420,
          lateMinutes: 0,
          overtimeMinutes: 0,
        },
      }),
    );
    const response = await (await api(ADMIN_A))
      .post(`/payroll/periods/${periodId}/recalculate`)
      .send({ proceed_with_warnings: true });
    expect(response.status).toBe(200);
    const p = response.body.data as Period;
    expect(p.lines.find((l) => l.employee.id === ids.manager)).toMatchObject({
      absent_days: 0,
      net_salary: '30000.00',
      status: 'calculated',
    });
    expect(p.lines.find((l) => l.employee.id === ids.worker2)).toMatchObject({
      total_deductions: '500.00',
      total_bonuses: '250.50',
      net_salary: '22750.50',
    });
    expectTotalsEqualLines(p);
    expect(await audits('PAYROLL_REGENERATED', periodId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The state machine — DOCUMENT 15 "PAYROLL STATES", FLOW 16
// ---------------------------------------------------------------------------

describe('review, approval and their reversals', () => {
  it('rejects every transition the state does not allow', async () => {
    const admin = await api(ADMIN_A);
    for (const action of ['approve', 'return-to-draft', 'return-to-review', 'mark-paid']) {
      const response = await admin.post(`/payroll/periods/${periodId}/${action}`).send({});
      expect(response.status, action).toBe(409);
    }
    expect(
      (await admin.post(`/payroll/periods/${periodId}/finalize`).send({ confirm: '2026-03' }))
        .status,
    ).toBe(409);
  });

  it('draft → under review → draft → under review → approved → under review → approved', async () => {
    const admin = await api(ADMIN_A);
    const step = async (action: string, expected: string) => {
      const response = await admin.post(`/payroll/periods/${periodId}/${action}`).send({});
      expect(response.status, action).toBe(200);
      expect(response.body.data.status).toBe(expected);
    };
    await step('submit-review', 'under_review');
    await step('return-to-draft', 'draft');
    await step('submit-review', 'under_review');
    // Entries are still allowed under review.
    const omar = await lineOf(ids.worker);
    expect(
      (
        await admin
          .post(`/payroll/lines/${omar.id}/bonuses`)
          .send({ amount: '100.00', reason: 'Referral' })
      ).status,
    ).toBe(201);
    await step('approve', 'approved');
    await step('return-to-review', 'under_review');
    await step('approve', 'approved');
    expect(await audits('PAYROLL_SUBMITTED_FOR_REVIEW', periodId)).toHaveLength(3);
    expect(await audits('PAYROLL_RETURNED_TO_DRAFT', periodId)).toHaveLength(1);
    expect(await audits('PAYROLL_APPROVED', periodId)).toHaveLength(2);
  });

  it('approved is not editable: no entries, no recalculation', async () => {
    const admin = await api(ADMIN_A);
    const omar = await lineOf(ids.worker);
    const entry = await admin
      .post(`/payroll/lines/${omar.id}/deductions`)
      .send({ amount: '1.00', reason: 'Too late' });
    expect(entry.status).toBe(409);
    expect(entry.body.error.code).toBe('PAYROLL_INVALID_TRANSITION');
    expect((await admin.post(`/payroll/periods/${periodId}/recalculate`).send({})).status).toBe(
      409,
    );
  });
});

// ---------------------------------------------------------------------------
// Finalization — DOCUMENT 15 rules 1, 11
// ---------------------------------------------------------------------------

describe('finalization: typed confirmation, one transaction, then immutable', () => {
  it('the confirmation must name the period', async () => {
    const admin = await api(ADMIN_A);
    for (const confirm of ['2026-3', '2026-04', 'March']) {
      const response = await admin.post(`/payroll/periods/${periodId}/finalize`).send({ confirm });
      expect(response.status).toBe(422);
      expect(response.body.error.fields).toEqual({ confirm: ['mismatch'] });
    }
    expect((await admin.post(`/payroll/periods/${periodId}/finalize`).send({})).status).toBe(422);
  });

  it('a forced failure while locking any line finalizes nothing', async () => {
    const omar = await lineOf(ids.worker);
    await withFailingTrigger(
      'payroll_lines',
      `TG_OP = 'UPDATE' AND NEW.id = '${omar.id}'::uuid AND NEW.is_locked`,
      async () => {
        const response = await (await api(ADMIN_A))
          .post(`/payroll/periods/${periodId}/finalize`)
          .send({ confirm: '2026-03' });
        expect(response.status).toBe(500);
      },
    );
    const p = await period();
    expect(p.status).toBe('approved');
    expect(p.lines.every((l) => !l.is_locked)).toBe(true);
    expect(await audits('PAYROLL_FINALIZED')).toEqual([]);
  });

  it('two concurrent finalizations: exactly one succeeds, the other is 409', async () => {
    const admin = await api(ADMIN_A);
    const send = () =>
      admin.post(`/payroll/periods/${periodId}/finalize`).send({ confirm: '2026-03' });
    const responses = await Promise.all([send(), send()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const p = await period();
    expect(p.status).toBe('finalized');
    expect(p.lines.every((l) => l.is_locked)).toBe(true);
    expectTotalsEqualLines(p);
    expect(await audits('PAYROLL_FINALIZED', periodId)).toHaveLength(1);
    expect(payrollSink.events.map((e) => e.type)).toEqual(['payroll_finalized']);
  });

  it('every line carries a full snapshot of what it was calculated from', async () => {
    const omar = await lineOf(ids.worker);
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.payrollLine.findUniqueOrThrow({ where: { id: omar.id } }),
    );
    const snapshot = row.snapshot as unknown as {
      policy: Record<string, unknown>;
      schedule: { days: unknown[] };
      salaries: Record<string, unknown>[];
      segments: Record<string, unknown>[];
      days: unknown[];
      exact: { base: string };
      final: Record<string, unknown>;
    };
    expect(snapshot.policy).toMatchObject({
      daily_wage_basis: 'fixed_days',
      fixed_days_value: 30,
      rounding: 'none',
    });
    expect(snapshot.schedule.days).toHaveLength(7);
    expect(snapshot.salaries.map((s: Record<string, unknown>) => s.monthly_salary)).toEqual([
      '20000.00',
      '26000.00',
    ]);
    expect(snapshot.segments.map((s: Record<string, unknown>) => s.working_days)).toEqual([11, 12]);
    expect(snapshot.days).toHaveLength(31);
    expect(snapshot.exact.base).toBe('532000/23');
    expect(snapshot.final).toMatchObject({
      period: '2026-03',
      bonuses: [expect.objectContaining({ amount: '100.00', reason: 'Referral' })],
      figures: { net_salary: '22501.86', base_salary: '23130.43' },
    });
  });

  it('a later policy or salary change never touches the finalized figures', async () => {
    const before = await lineOf(ids.worker);
    expect(
      (await (await api(ADMIN_A)).patch('/salary-policies').send({ fixed_days_value: 26 })).status,
    ).toBe(200);
    expect(await lineOf(ids.worker)).toEqual(before);
    expect(
      (await (await api(ADMIN_A)).patch('/salary-policies').send({ fixed_days_value: 30 })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Immutability — API, service, database
// ---------------------------------------------------------------------------

describe('a finalized line cannot be changed — not by the API, the service, or the database', () => {
  it('API: entries, recalculation and transitions are refused', async () => {
    const admin = await api(ADMIN_A);
    const omar = await lineOf(ids.worker);
    const entry = await admin
      .post(`/payroll/lines/${omar.id}/deductions`)
      .send({ amount: '1.00', reason: 'After the fact' });
    expect(entry.status).toBe(409);
    expect(entry.body.error.code).toBe('PAYROLL_LINE_LOCKED');
    const recalc = await admin.post(`/payroll/periods/${periodId}/recalculate`).send({});
    expect(recalc.status).toBe(409);
    expect(recalc.body.error.code).toBe('PAYROLL_PERIOD_FINALIZED');
    expect(
      (await admin.post(`/payroll/periods/${periodId}/return-to-review`).send({})).status,
    ).toBe(409);
    expect(
      (await admin.post('/payroll/periods').send({ year: 2026, month: 3 })).body.error.code,
    ).toBe('PAYROLL_PERIOD_EXISTS');
  });

  it('service: called directly, it refuses too', async () => {
    const service = app.get(PayrollService);
    const ctx = {
      sessionId: generateId(),
      userId: (
        await withTenant(prisma, COMPANY_A, (tx) =>
          tx.user.findFirstOrThrow({ where: { email: ADMIN_A.email } }),
        )
      ).id,
      companyId: COMPANY_A,
      roleId: generateId(),
      roleKey: 'admin',
      permissions: new Map([['payroll.add_bonus', 'company']]),
      clientType: 'web',
      callerEmployeeId: null,
    } as unknown as AuthContext;
    const omar = await lineOf(ids.worker);
    await expect(
      service.addEntry(ctx, omar.id, 'bonus', { amount: '1.00', reason: 'Sneaky' }, null, {
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toMatchObject({ appErrorCode: 'PAYROLL_LINE_LOCKED' });
  });

  it('database: the application role can neither UPDATE nor DELETE a locked line', async () => {
    const omar = await lineOf(ids.worker);
    for (const sql of [
      `UPDATE payroll_lines SET net_salary = 1 WHERE id = '${omar.id}'`,
      `UPDATE payroll_lines SET is_locked = false WHERE id = '${omar.id}'`,
      `DELETE FROM payroll_lines WHERE id = '${omar.id}'`,
    ]) {
      await expect(
        withTenant(prisma, COMPANY_A, (tx) => tx.$executeRawUnsafe(sql)),
      ).rejects.toThrow(/locked: finalized payroll is immutable|foreign key/);
    }
    expect((await lineOf(ids.worker)).net_salary).toBe('22501.86');
  });
});

// ---------------------------------------------------------------------------
// The finalized-period guards — Attendance and Leave (Phase 10 handoff)
// ---------------------------------------------------------------------------

describe('a finalized period freezes its attendance and leave', () => {
  it('an admin attendance adjustment inside it is refused', async () => {
    const record = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: ids.worker, date: new Date('2026-03-02T00:00:00.000Z') },
      }),
    );
    const response = await (await api(ADMIN_A))
      .patch(`/attendance/${record.id}`)
      .send({ status: 'present', reason: 'He was there after all' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYROLL_PERIOD_FINALIZED');
    expect(response.body.error.fields).toEqual({ periods: ['2026-03'] });
  });

  it('approving a correction for a day inside it is refused', async () => {
    const correctionId = generateId();
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceCorrectionRequest.create({
        data: {
          id: correctionId,
          companyId: COMPANY_A,
          employeeId: ids.worker,
          date: new Date('2026-03-02T00:00:00.000Z'),
          requestedCheckIn: new Date('2026-03-02T07:00:00.000Z'),
          requestedCheckOut: new Date('2026-03-02T15:00:00.000Z'),
          requestedWorkMode: 'office',
          reason: 'Forgot to check in',
          status: 'pending',
        },
      }),
    );
    const response = await (await api(ADMIN_A))
      .post(`/attendance-corrections/${correctionId}/approve`)
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYROLL_PERIOD_FINALIZED');
  });

  it('approving leave inside it is refused, and so is a new request for it', async () => {
    const response = await (await api(ADMIN_A))
      .post(`/leave-requests/${managerLeaveId}/approve`)
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_PERIOD_FINALIZED');
    const types = (await (await api(WORKER)).get('/leave-types')).body.data as {
      id: string;
      name_en: string;
    }[];
    const submitted = await (await api(WORKER)).post('/leave-requests').send({
      leave_type_id: types.find((t) => t.name_en === 'Unpaid')?.id,
      start_date: '2026-03-25',
      end_date: '2026-03-25',
      reason: 'Retroactive',
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error.code).toBe('LEAVE_PERIOD_FINALIZED');
  });

  it('cancelling approved leave inside it is refused', async () => {
    const response = await (await api(ADMIN_A))
      .post(`/leave-requests/${adminEmpLeaveId}/cancel`)
      .send({ reason: 'Recalled' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('LEAVE_PERIOD_FINALIZED');
  });

  it('a salary change effective inside it is refused', async () => {
    const response = await (await api(ADMIN_A))
      .post(`/employees/${ids.newcomer}/salary`)
      .send({ monthly_salary: '21000.00', effective_from: '2026-03-20' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYROLL_PERIOD_FINALIZED');
  });
});

// ---------------------------------------------------------------------------
// Paid and adjusted — DOCUMENT 15 rule 2
// ---------------------------------------------------------------------------

describe('mark paid, then adjust: the original line never changes', () => {
  it('marks paid once', async () => {
    const admin = await api(ADMIN_A);
    const paid = await admin.post(`/payroll/periods/${periodId}/mark-paid`).send({});
    expect(paid.status).toBe(200);
    expect(paid.body.data.status).toBe('paid');
    expect(paid.body.data.paid_at).not.toBeNull();
    expect((await admin.post(`/payroll/periods/${periodId}/mark-paid`).send({})).status).toBe(409);
    expect(await audits('PAYROLL_MARKED_PAID', periodId)).toHaveLength(1);
  });

  it('an adjustment is recorded beside the line; the outcome is derived; the period becomes adjusted', async () => {
    const admin = await api(ADMIN_A);
    const omar = await lineOf(ids.worker);
    const response = await admin
      .post(`/payroll/lines/${omar.id}/adjustments`)
      .set('Idempotency-Key', 'omar-overtime')
      .send({ amount: '-150.25', reason: 'Overpaid transport' });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      net_salary: '22501.86',
      adjustments_total: '-150.25',
      adjusted_net: '22351.61',
    });
    expect(response.body.data.adjustments).toEqual([
      expect.objectContaining({ amount: '-150.25', reason: 'Overpaid transport' }),
    ]);
    const replay = await admin
      .post(`/payroll/lines/${omar.id}/adjustments`)
      .set('Idempotency-Key', 'omar-overtime')
      .send({ amount: '-150.25', reason: 'Overpaid transport' });
    expect(replay.body.data.adjustments).toHaveLength(1);
    const p = await period();
    expect(p.status).toBe('adjusted');
    expect(p.paid_at).not.toBeNull();
    expect(p.total_net).toBe(sum(p.lines.map((l) => l.net_salary)));
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.payrollLine.findUniqueOrThrow({ where: { id: omar.id } }),
    );
    expect(row.netSalary.toString()).toBe('22501.86');
    expect(row.isLocked).toBe(true);
    expect(await audits('PAYROLL_ADJUSTMENT_CREATED', omar.id)).toHaveLength(1);
  });

  it('a zero amount, a missing reason, or a negative outcome is refused', async () => {
    const admin = await api(ADMIN_A);
    const omar = await lineOf(ids.worker);
    expect(
      (
        await admin
          .post(`/payroll/lines/${omar.id}/adjustments`)
          .send({ amount: '0.00', reason: 'Nothing' })
      ).status,
    ).toBe(422);
    expect(
      (await admin.post(`/payroll/lines/${omar.id}/adjustments`).send({ amount: '10.00' })).status,
    ).toBe(422);
    const negative = await admin
      .post(`/payroll/lines/${omar.id}/adjustments`)
      .send({ amount: '-30000.00', reason: 'Clawback' });
    expect(negative.status).toBe(422);
    expect(negative.body.error.fields).toEqual({ resulting_net: ['-7648.39'] });
    expect(
      (
        await (await api(MANAGER))
          .post(`/payroll/lines/${omar.id}/adjustments`)
          .send({ amount: '1.00', reason: 'Nope' })
      ).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The employee's own — DOCUMENT 15 rules 9–10, DOCUMENT 04 C-salary
// ---------------------------------------------------------------------------

describe('the employee sees only their own, and the current month as an estimate', () => {
  it('this month is a provisional estimate', async () => {
    const response = await (await api(WORKER)).get('/payroll/me');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      label: '2026-04',
      provisional: true,
      available: true,
      currency: 'EGP',
      monthly_salary: '26000.00',
      daily_wage: '866.67',
    });
    // No April attendance yet. The 7 working days that have ended (1–9 April)
    // count as absent at 26,000 ÷ 30; today and later are projected, not charged.
    expect(response.body.data.working_days).toBe(22);
    expect(response.body.data.absent_days).toBe(7);
    expect(response.body.data.estimated_net).toBe('19933.33');
  });

  it('their finalized payslips, newest first, with the adjustment history', async () => {
    const history = await (await api(WORKER)).get('/payroll/me/history');
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(1);
    const own = history.body.data[0] as Line;
    expect(own).toMatchObject({ net_salary: '22501.86', adjusted_net: '22351.61' });
    const payslip = await (await api(WORKER)).get(`/payroll/lines/${own.id}`);
    expect(payslip.status).toBe(200);
    expect(payslip.body.data.breakdown).toMatchObject({
      working_days_in_month: 23,
      absence: '666.67',
      lateness: '61.90',
    });
    expect(payslip.body.data.can_adjust).toBe(false);
  });

  it('another employee’s payslip is 404, and so is a line in another company', async () => {
    const sara = await lineOf(ids.worker2);
    expect((await (await api(WORKER)).get(`/payroll/lines/${sara.id}`)).status).toBe(404);
    expect(
      (await (await api(WORKER)).get(`/payroll/lines?employee_id=${ids.worker2}`)).body.data,
    ).toEqual([]);
    expect((await (await api(WORKER_B)).get(`/payroll/lines/${sara.id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Audit — DOCUMENT 21 "Payroll"
// ---------------------------------------------------------------------------

describe('audit: every payroll action, canonical names, after commit', () => {
  it('recorded every action with its creator', async () => {
    const all = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({
        where: { entityType: { in: ['payroll_period', 'payroll_line', 'salary_policy'] } },
      }),
    );
    const actions = new Set(all.map((row) => row.action));
    for (const action of [
      'PAYROLL_GENERATED',
      'PAYROLL_REGENERATED',
      'PAYROLL_SUBMITTED_FOR_REVIEW',
      'PAYROLL_APPROVED',
      'PAYROLL_RETURNED_TO_DRAFT',
      'PAYROLL_FINALIZED',
      'PAYROLL_MARKED_PAID',
      'PAYROLL_ADJUSTMENT_CREATED',
      'DEDUCTION_ADDED',
      'BONUS_ADDED',
      'SALARY_POLICY_CHANGED',
    ]) {
      expect(actions.has(action as AuditAction), action).toBe(true);
    }
    const admin = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirstOrThrow({ where: { email: ADMIN_A.email } }),
    );
    expect(all.every((row) => row.userId === admin.id)).toBe(true);
    expect(retryQueue.entries).toEqual([]);
  });
});
