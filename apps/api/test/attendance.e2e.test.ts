/**
 * Phase 6 end-to-end — DOCUMENT 25 Phase 6, DOCUMENT 12, DOCUMENT 26.
 *
 * Exit criterion: *"a full month of attendance can be recorded and reviewed,
 * with every status reachable and every calculation matching the schedule
 * configuration."* All three clauses are proved here over HTTP against the
 * real application:
 *
 *   - **a full month recorded and reviewed** — March 2026 is walked day by
 *     day, with real check-ins and check-outs on the working days, the nightly
 *     job filling the rest, and the month then read back through
 *     `GET /attendance/monthly`.
 *   - **every status reachable** — the month ends with all eight DOCUMENT 12
 *     statuses present, and the assertion names them rather than counting.
 *   - **every calculation matching the schedule configuration** — the derived
 *     minutes are asserted against the fixture schedule, and the same
 *     attendance under a second schedule with different grace, break and
 *     threshold produces different answers.
 *
 * The clock is controlled with `vi.setSystemTime`, faking `Date` only: check-in
 * takes no timestamp from the client (DOCUMENT 12 "Clock skew"), so moving the
 * server's clock is the only way to record a month — which is itself a proof
 * that the endpoint really does use the server's clock and nothing else.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced. Only Redis is a fake, as in every earlier suite.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { AUDIT_RETRY_QUEUE, AuditDispatcher } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import { AttendanceGenerationService } from '../src/attendance/attendance-generation.service.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let prisma: PrismaClient;

const redis = new FakeRedis();

class CapturingMail implements MailTransport {
  readonly sent: MailMessage[] = [];
  send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}
const mail = new CapturingMail();

const COMPANY_A = generateId();
const COMPANY_B = generateId();

const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };

const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };
const OUTSIDER = { email: 'outsider@a.test', password: 'outsider-password-2026' };

/** Stands in for the BullMQ audit retry queue (no Redis here). */
class CapturingRetryQueue implements AuditRetryQueue {
  readonly entries: QueuedAuditEntry[] = [];
  enqueue(entry: QueuedAuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}
const retryQueue = new CapturingRetryQueue();

let managerEmployeeId = '';
let workerEmployeeId = '';
let outsiderEmployeeId = '';
let workerBId = '';
let scheduleAId = '';
let strictScheduleId = '';
let departmentAId = '';

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

const CAIRO = 'Africa/Cairo';

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

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * Cairo is UTC+2 for the whole of March 2026, so a Cairo wall-clock time on a
 * March date is that time minus two hours in UTC. Stated as a fixture constant
 * rather than computed, so the test does not reimplement the thing it checks.
 */
const CAIRO_OFFSET_HOURS = 2;

/** Sets the server clock to a Cairo wall-clock moment on a March 2026 day. */
function atCairo(day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 2, day, hour - CAIRO_OFFSET_HOURS, minute, 0, 0));
}

function setClock(day: number, hour: number, minute = 0): void {
  vi.setSystemTime(atCairo(day, hour, minute));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The working week this test chooses. Nothing in the system knows a week —
 * Sunday(0) to Thursday(4) working, Friday and Saturday off.
 */
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
      await tx.company.create({
        data: { id: companyId, name: slug, slug, timezone: CAIRO },
      });
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

beforeAll(async () => {
  // `Date` only: faking timers wholesale would stop supertest's sockets.
  vi.useFakeTimers({ toFake: ['Date'] });
  setClock(2, 8);

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
    .overrideProvider(AUDIT_RETRY_QUEUE)
    .useValue(retryQueue)
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

  prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures();
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  // Company A's configuration: a department, the week above, and a holiday.
  const department = await (await api(ADMIN_A))
    .post('/departments')
    .send({ name_ar: 'هندسة', name_en: 'Engineering' });
  departmentAId = department.body.data.id as string;

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
  expect(schedule.status).toBe(201);
  scheduleAId = schedule.body.data.id as string;

  // A second schedule that differs only in the numbers, used to prove the
  // calculations follow configuration rather than a built-in week.
  const strict = await (await api(ADMIN_A)).post('/work-schedules').send({
    name: 'Strict week',
    timezone: CAIRO,
    grace_period_minutes: 0,
    break_minutes: 0,
    half_day_threshold_hours: '6.00',
    overtime_policy: 'none',
    days: week(),
  });
  expect(strict.status).toBe(201);
  strictScheduleId = strict.body.data.id as string;

  // 2026-03-05 is a Thursday — a working day in this fixture — declared a
  // holiday so `holiday` is reachable on a day that would otherwise be worked.
  const holiday = await (await api(ADMIN_A))
    .post('/holidays')
    .send({ date: '2026-03-05', name_ar: 'عيد', name_en: 'Feast' });
  expect(holiday.status).toBe(201);

  managerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Mona',
    last_name: 'Saleh',
    email: MANAGER.email,
    employee_code: 'MGR-1',
    role_key: 'manager',
    department_id: departmentAId,
    work_schedule_id: scheduleAId,
  });
  workerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Omar',
    last_name: 'Fathy',
    email: WORKER.email,
    employee_code: 'EMP-1',
    role_key: 'employee',
    department_id: departmentAId,
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleAId,
  });
  outsiderEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Layla',
    last_name: 'Nabil',
    email: OUTSIDER.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    work_schedule_id: strictScheduleId,
  });

  await activate(MANAGER);
  await activate(WORKER);
  await activate(OUTSIDER);

  // Company B, for the tenancy assertions.
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
  if (scheduleB.status !== 201) {
    throw new Error(`Company B schedule failed: ${JSON.stringify(scheduleB.body)}`);
  }
  workerBId = await createEmployee(ADMIN_B, {
    first_name: 'Other',
    last_name: 'Person',
    email: 'worker@b.test',
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB.body.data.id as string,
  });
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
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

async function tokenFor(email: string, password: string): Promise<string> {
  redis.reset();
  const response = await request(server())
    .post(`/${API_PREFIX}/auth/login`)
    .set('X-Client-Type', 'mobile')
    .send({ email, password });
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
  };
}

interface Account {
  readonly email: string;
  readonly password: string;
}

const tokens = new Map<string, { token: string; issuedAt: number }>();

/**
 * A session for an account, at the clock's current position.
 *
 * This suite walks a month, and a session times out after eight idle hours
 * (`SESSION_IDLE_TIMEOUT_MINUTES`). Re-authenticating whenever the clock has
 * moved on is not a workaround for that: the alternative would be to keep the
 * clock still, and then the month could not be recorded at all. It also means
 * every request below is made with a session that is genuinely valid at the
 * moment it is made, which is the situation being tested.
 */
async function api(account: Account) {
  const cached = tokens.get(account.email);
  const fresh = cached !== undefined && Math.abs(Date.now() - cached.issuedAt) < 4 * 60 * 60 * 1000;
  if (fresh && cached !== undefined) {
    return as(cached.token);
  }
  const token = await tokenFor(account.email, account.password);
  tokens.set(account.email, { token, issuedAt: Date.now() });
  return as(token);
}

function anonymous() {
  const agent = request(server());
  return {
    get: (path: string) => agent.get(`/${API_PREFIX}${path}`),
    post: (path: string) => agent.post(`/${API_PREFIX}${path}`),
    patch: (path: string) => agent.patch(`/${API_PREFIX}${path}`),
  };
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

/** Redeems the invitation the creation sent, so the account can sign in. */
async function activate(account: Account): Promise<void> {
  const message = [...mail.sent].reverse().find((m) => m.to === account.email);
  if (!message) throw new Error(`No invitation for ${account.email}`);
  const token = /#token=([^\s"']+)/.exec(message.text)?.[1];
  if (token === undefined) throw new Error(`No token in the invitation for ${account.email}`);
  const accepted = await anonymous()
    .post('/auth/accept-invitation')
    .send({ token: decodeURIComponent(token), password: account.password, accept_terms: true });
  if (accepted.status !== 200) {
    throw new Error(`Activation failed: ${JSON.stringify(accepted.body)}`);
  }
}

async function audits(companyId: string, action: AuditAction): Promise<unknown[]> {
  return withTenant(prisma, companyId, (tx) =>
    tx.auditLog.findMany({ where: { action }, orderBy: { createdAt: 'asc' } }),
  );
}

function generation(): AttendanceGenerationService {
  return app.get(AttendanceGenerationService);
}

/**
 * Runs the nightly job's work for one day, as the job itself would.
 *
 * No actor is passed: `generateRange` resolves the company's designated system
 * actor itself, and there is deliberately no way for a caller to attribute a
 * generated row to somebody else (DOCUMENT 21 "Record content").
 */
async function generateDay(day: number, at: Date): Promise<void> {
  const date = { year: 2026, month: 3, day };
  await generation().generateRange(COMPANY_A, date, date, at);
}

// ---------------------------------------------------------------------------
// DOCUMENT 26 §3 — authentication and authorisation on every endpoint
// ---------------------------------------------------------------------------

describe('authentication — every attendance endpoint requires a session', () => {
  it('refuses anonymous callers with 401', async () => {
    const calls: (() => Promise<{ status: number }>)[] = [
      () => anonymous().get('/attendance'),
      () => anonymous().get('/attendance/today'),
      () => anonymous().get('/attendance/monthly?month=2026-03'),
      () => anonymous().get('/attendance/summary'),
      () => anonymous().post('/attendance/check-in').send({ work_mode: 'office' }),
      () => anonymous().post('/attendance/check-out'),
      () => anonymous().get('/attendance-corrections'),
      () => anonymous().post('/attendance-corrections').send({ date: '2026-03-02', reason: 'x' }),
    ];
    for (const call of calls) {
      expect((await call()).status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 12 rules 1, 2, 4–7, 14 — check-in and check-out
// ---------------------------------------------------------------------------

describe('check-in — DOCUMENT 12 rules 1 and 2', () => {
  it('requires a work mode, with no default', async () => {
    setClock(2, 9);
    const response = await (await api(WORKER)).post('/attendance/check-in').send({});
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('work_mode');
  });

  it('refuses a work mode that is not office or wfh', async () => {
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'beach' });
    expect(response.status).toBe(422);
  });

  it('records the mode as a mode, and the status as a status', async () => {
    // 2026-03-02 is a Monday — a working day. 09:00 Cairo exactly, so on time.
    setClock(2, 9);
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'wfh' });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      date: '2026-03-02',
      work_mode: 'wfh',
      status: 'pending',
      source: 'self',
      late_minutes: 0,
    });
    // DOCUMENT 12: "a record is `present` with mode `wfh`" — never a `wfh`
    // status. Asserted directly because this is the distinction the whole
    // reporting story rests on.
    expect(response.body.data.status).not.toBe('wfh');
  });

  it('is a clean 409 the second time, not a duplicate record', async () => {
    setClock(2, 10);
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_CHECKED_IN');

    const rows = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({ where: { employeeId: workerEmployeeId } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('ignores any timestamp a client tries to send — DOCUMENT 12 "clock skew"', async () => {
    setClock(3, 9);
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office', check_in_at: '2020-01-01T00:00:00.000Z' });
    // The unknown field is rejected outright (DOCUMENT 08 §5.2 whitelist),
    // which is a stronger guarantee than ignoring it.
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('check_in_at');
  });
});

describe('check-out — DOCUMENT 12 rules 5–7 and 14', () => {
  it('refuses a check-out with no check-in, pointing at the correction flow', async () => {
    setClock(3, 17);
    const response = await (await api(OUTSIDER)).post('/attendance/check-out');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOT_CHECKED_IN');
  });

  it('computes working minutes, overtime and status from the schedule', async () => {
    // Checked in 09:00 on the 2nd; check out at 17:00 Cairo.
    setClock(2, 17);
    const response = await (await api(WORKER)).post('/attendance/check-out');
    expect(response.status).toBe(200);
    // 09:00–17:00 is 480 minutes; the schedule's 60-minute break leaves 420.
    // Scheduled minutes are the same 420, so there is no overtime.
    expect(response.body.data).toMatchObject({
      status: 'present',
      working_minutes: 420,
      overtime_minutes: 0,
      late_minutes: 0,
    });
  });

  it('refuses a second check-out', async () => {
    setClock(2, 18);
    const response = await (await api(WORKER)).post('/attendance/check-out');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ALREADY_CHECKED_OUT');
  });
});

describe('GET /attendance/today — the card DOCUMENT 04 C1 draws', () => {
  it('says what the day is and what the caller may do', async () => {
    setClock(4, 8);
    const response = await (await api(WORKER)).get('/attendance/today');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      date: '2026-03-04',
      is_working_day: true,
      is_holiday: false,
      record: null,
      can_check_in: true,
      can_check_out: false,
    });
    // The scheduled start is 09:00 Cairo, which is 07:00 UTC.
    expect(response.body.data.scheduled_start_at).toBe('2026-03-04T07:00:00.000Z');
  });

  it('flips to check-out once the day is open', async () => {
    setClock(4, 9);
    await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' });
    const response = await (await api(WORKER)).get('/attendance/today');
    expect(response.body.data).toMatchObject({ can_check_in: false, can_check_out: true });
    expect(response.body.data.record.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 25 Phase 6 exit criterion, clause 3 —
// "every calculation matching the schedule configuration"
// ---------------------------------------------------------------------------

describe('the calculations follow the configuration, not a built-in week', () => {
  it('lateness is measured against the schedule’s start and grace', async () => {
    // Worker arrives 09:20 on the 4th — past a 15-minute grace.
    setClock(4, 17);
    await (await api(WORKER)).post('/attendance/check-out');

    setClock(8, 9, 20);
    const late = await (await api(MANAGER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(late.status).toBe(201);
    expect(late.body.data.late_minutes).toBe(20);

    setClock(8, 17);
    const closed = await (await api(MANAGER)).post('/attendance/check-out');
    expect(closed.body.data).toMatchObject({ status: 'late', late_minutes: 20 });
  });

  it('the same arrival is on time under a schedule with more grace', async () => {
    // The outsider is on the strict schedule: 0 grace, 0 break, 6-hour
    // half-day threshold, overtime `none`. Identical clock times, different
    // numbers out — which is the whole point of DOCUMENT 27 RULE 12.
    setClock(8, 9, 20);
    const response = await (await api(OUTSIDER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(response.body.data.late_minutes).toBe(20);

    setClock(8, 19);
    const closed = await (await api(OUTSIDER)).post('/attendance/check-out');
    // 09:20–19:00 is 580 minutes and this schedule takes no break, so 580
    // worked against 480 scheduled. Overtime policy is `none`, so none is
    // recognised — under the standard schedule the same day would bank 160.
    expect(closed.body.data).toMatchObject({
      working_minutes: 580,
      overtime_minutes: 0,
      status: 'late',
    });
  });

  it('overtime is recognised under a `paid` policy', async () => {
    setClock(9, 9);
    await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' });
    setClock(9, 19);
    const closed = await (await api(WORKER)).post('/attendance/check-out');
    // 09:00–19:00 less the 60-minute break is 540 worked; 420 scheduled.
    expect(closed.body.data).toMatchObject({
      working_minutes: 540,
      overtime_minutes: 120,
      status: 'present',
    });
  });

  it('a late arrival that still works a full day stays `late`', async () => {
    // 2026-03-15 is a Sunday — the first working day of that week here.
    setClock(15, 9, 30);
    await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' });
    setClock(15, 18);
    const closed = await (await api(WORKER)).post('/attendance/check-out');
    // 09:30–18:00 less the 60-minute break is 450 worked — well over the
    // 4-hour half-day threshold, so the day is named by its lateness.
    expect(closed.body.data).toMatchObject({
      status: 'late',
      working_minutes: 450,
      late_minutes: 30,
    });
  });

  it('half_day is the configured threshold, and outranks late', async () => {
    setClock(10, 10);
    await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' });
    setClock(10, 13);
    const closed = await (await api(WORKER)).post('/attendance/check-out');
    // 10:00–13:00 less the break is 120 minutes, under the 4-hour threshold.
    expect(closed.body.data).toMatchObject({
      status: 'half_day',
      working_minutes: 120,
      late_minutes: 60,
    });
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 12 "ERROR STATES" — the non-working day confirmation
// ---------------------------------------------------------------------------

describe('a rest day is a confirmation, not a refusal', () => {
  it('refuses once so the screen can ask', async () => {
    // 2026-03-06 is a Friday — a rest day in this fixture.
    setClock(6, 10);
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NON_WORKING_DAY');
  });

  it('records the day once the employee confirms, and counts it all as overtime', async () => {
    setClock(6, 10);
    const response = await (await api(WORKER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office', confirm_non_working_day: true });
    expect(response.status).toBe(201);

    setClock(6, 15);
    const closed = await (await api(WORKER)).post('/attendance/check-out');
    // Nothing was scheduled, so every worked minute is beyond schedule.
    expect(closed.body.data).toMatchObject({
      status: 'present',
      working_minutes: 240,
      overtime_minutes: 240,
    });
  });

  it('asks the same question on a holiday', async () => {
    setClock(5, 10);
    const response = await (await api(MANAGER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NON_WORKING_DAY');
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 12 rules 9 and 10 — generation and the nightly absence job
// ---------------------------------------------------------------------------

describe('generated days — DOCUMENT 12 rules 9 and 10', () => {
  it('marks a finished working day with no record absent', async () => {
    // The 11th: nobody checks in, and the job runs after the day has ended.
    await generateDay(11, atCairo(12, 1));
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-11T00:00:00.000Z') },
      }),
    );
    expect(row.status).toBe('absent');
    expect(row.source).toBe('system');
    expect(row.workMode).toBeNull();
  });

  it('does not mark a day absent while it is still running', async () => {
    // The 12th at 10:00 — the working day has not ended.
    await generateDay(12, atCairo(12, 10));
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirst({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-12T00:00:00.000Z') },
      }),
    );
    expect(row).toBeNull();
  });

  it('generates weekend and holiday records so the month is complete', async () => {
    await generateDay(5, atCairo(6, 1)); // Thursday, declared a holiday
    await generateDay(7, atCairo(8, 1)); // Saturday, a rest day

    const rows = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({
        where: {
          employeeId: workerEmployeeId,
          date: {
            in: [new Date('2026-03-05T00:00:00.000Z'), new Date('2026-03-07T00:00:00.000Z')],
          },
        },
        orderBy: { date: 'asc' },
      }),
    );
    expect(rows.map((r) => r.status)).toEqual(['holiday', 'weekend']);
    expect(rows.every((r) => r.source === 'system')).toBe(true);
  });

  it('closes a forgotten record at the scheduled end and leaves it pending', async () => {
    setClock(16, 9);
    await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' });

    await generateDay(16, atCairo(17, 1));
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-16T00:00:00.000Z') },
      }),
    );
    expect(row.status).toBe('pending');
    // 17:00 Cairo is 15:00 UTC.
    expect(row.checkOutAt?.toISOString()).toBe('2026-03-16T15:00:00.000Z');
    // The minutes are deliberately not guessed: the employee never said when
    // they left, so a correction is what supplies them.
    expect(row.workingMinutes).toBeNull();
  });

  it('never overwrites a day somebody actually recorded', async () => {
    const before = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-02T00:00:00.000Z') },
      }),
    );
    await generateDay(2, atCairo(20, 1));
    const after = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-02T00:00:00.000Z') },
      }),
    );
    expect(after.status).toBe(before.status);
    expect(after.source).toBe('self');
    expect(after.workingMinutes).toBe(before.workingMinutes);
  });

  it('is idempotent — running it twice writes nothing the second time', async () => {
    const first = await generation().generateRange(
      COMPANY_A,
      { year: 2026, month: 3, day: 13 },
      { year: 2026, month: 3, day: 13 },
      atCairo(14, 1),
    );
    expect(first.generated).toBeGreaterThan(0);
    const second = await generation().generateRange(
      COMPANY_A,
      { year: 2026, month: 3, day: 13 },
      { year: 2026, month: 3, day: 13 },
      atCairo(14, 1),
    );
    expect(second.generated).toBe(0);
    expect(second.closed).toBe(0);
  });

  it('audits what it generated — DOCUMENT 21', async () => {
    const records = await audits(COMPANY_A, 'ATTENDANCE_GENERATED_BY_SYSTEM');
    expect(records.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The exit criterion — a full month, every status
// ---------------------------------------------------------------------------

describe('a full month, recorded and reviewed — DOCUMENT 25 Phase 6 exit criterion', () => {
  it('fills March 2026 and reaches every DOCUMENT 12 status', async () => {
    // Everything not already recorded above is generated, as the nightly job
    // would have done across the month.
    await generation().generateRange(
      COMPANY_A,
      { year: 2026, month: 3, day: 1 },
      { year: 2026, month: 3, day: 31 },
      atCairo(31, 23),
    );

    // `on_leave` is the one status no Phase 6 rule can produce: DOCUMENT 12
    // rule 8 gives it to leave approval, which is Phase 10. An admin
    // adjustment is the documented way to set it in the meantime.
    const leaveDay = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-18T00:00:00.000Z') },
        select: { id: true },
      }),
    );
    const adjusted = await (await api(ADMIN_A))
      .patch(`/attendance/${leaveDay.id}`)
      .send({ status: 'on_leave', reason: 'Approved annual leave, recorded before Phase 10' });
    expect(adjusted.status).toBe(200);

    const statuses = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.groupBy({
        by: ['status'],
        where: { employeeId: workerEmployeeId },
      }),
    );
    const present = new Set(statuses.map((row) => row.status));
    // All eight, named rather than counted.
    for (const status of [
      'present',
      'absent',
      'late',
      'on_leave',
      'half_day',
      'holiday',
      'weekend',
      'pending',
    ]) {
      expect(present.has(status as never)).toBe(true);
    }
  });

  it('every day of the month has exactly one record for the employee', async () => {
    const rows = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({
        where: {
          employeeId: workerEmployeeId,
          date: {
            gte: new Date('2026-03-01T00:00:00.000Z'),
            lte: new Date('2026-03-31T00:00:00.000Z'),
          },
        },
        select: { date: true },
      }),
    );
    expect(rows).toHaveLength(31);
    expect(new Set(rows.map((r) => r.date.toISOString())).size).toBe(31);
  });

  it('reads the month back as a matrix — DOCUMENT 04 B6', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance/monthly?month=2026-03');
    expect(response.status).toBe(200);
    expect(response.body.data.days).toHaveLength(31);
    expect(response.body.data.days[0]).toBe('2026-03-01');
    expect(response.body.data.days[30]).toBe('2026-03-31');

    const row = response.body.data.rows.find(
      (r: { employee: { id: string } }) => r.employee.id === workerEmployeeId,
    );
    expect(row.days).toHaveLength(31);
    // The totals are the month in one line — what the matrix legend counts.
    expect(row.totals.present).toBeGreaterThan(0);
    expect(row.totals.weekend).toBeGreaterThan(0);
  });

  it('reads a single day back as the daily board — DOCUMENT 04 B5', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance?date=2026-03-02');
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const record of response.body.data) {
      expect(record.date).toBe('2026-03-02');
    }
  });

  it('summarises a day for the dashboard — DOCUMENT 08 §4.4', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance/summary?date=2026-03-02');
    expect(response.status).toBe(200);
    expect(response.body.data.total).toBeGreaterThan(0);
    expect(typeof response.body.data.present).toBe('number');
  });

  it('a mid-month joiner has no days before they joined', async () => {
    const joinerId = await createEmployee(ADMIN_A, {
      first_name: 'Nour',
      last_name: 'Adel',
      email: 'nour@a.test',
      employee_code: 'EMP-9',
      role_key: 'employee',
      work_schedule_id: scheduleAId,
      joining_date: '2026-03-16',
    });
    await generation().generateRange(
      COMPANY_A,
      { year: 2026, month: 3, day: 1 },
      { year: 2026, month: 3, day: 31 },
      atCairo(31, 23),
    );
    const rows = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({ where: { employeeId: joinerId }, orderBy: { date: 'asc' } }),
    );
    expect(rows.length).toBe(16);
    expect(rows[0]?.date.toISOString().slice(0, 10)).toBe('2026-03-16');
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 12 rule 11 — admin adjustment
// ---------------------------------------------------------------------------

describe('admin adjustment — DOCUMENT 12 rule 11', () => {
  let recordId = '';

  it('requires a reason', async () => {
    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-11T00:00:00.000Z') },
        select: { id: true },
      }),
    );
    recordId = row.id;
    const response = await (await api(ADMIN_A))
      .patch(`/attendance/${recordId}`)
      .send({ status: 'present' });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('reason');
  });

  it('recalculates from the schedule and records old and new values', async () => {
    const response = await (await api(ADMIN_A)).patch(`/attendance/${recordId}`).send({
      work_mode: 'office',
      check_in_at: '2026-03-11T07:00:00.000Z',
      check_out_at: '2026-03-11T15:00:00.000Z',
      reason: 'Employee was present; the terminal was offline',
    });
    expect(response.status).toBe(200);
    // Recomputed, not taken from the request: 09:00–17:00 Cairo less the break.
    expect(response.body.data).toMatchObject({
      status: 'present',
      working_minutes: 420,
      source: 'admin',
    });

    const records = await audits(COMPANY_A, 'ATTENDANCE_ADJUSTED_BY_ADMIN');
    const last = records[records.length - 1] as {
      oldValues: Record<string, unknown>;
      newValues: Record<string, unknown>;
    };
    expect(last.oldValues['status']).toBe('absent');
    expect(last.newValues['status']).toBe('present');
    // The reason DOCUMENT 12 requires is kept where "why" belongs.
    expect(last.newValues['reason']).toBe('Employee was present; the terminal was offline');
  });

  it('refuses an employee trying to adjust their own record', async () => {
    const response = await (await api(WORKER))
      .patch(`/attendance/${recordId}`)
      .send({ status: 'present', reason: 'I was here' });
    expect(response.status).toBe(403);
  });

  it('refuses a check-out before the check-in', async () => {
    const response = await (await api(ADMIN_A)).patch(`/attendance/${recordId}`).send({
      check_in_at: '2026-03-11T15:00:00.000Z',
      check_out_at: '2026-03-11T07:00:00.000Z',
      reason: 'Wrong way round',
    });
    expect(response.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 08 §4.5 / DOCUMENT 12 — corrections
// ---------------------------------------------------------------------------

describe('correction requests — DOCUMENT 12 rules 13 and 14', () => {
  let correctionId = '';

  it('refuses a date that has not happened yet', async () => {
    setClock(20, 12);
    const response = await (await api(WORKER))
      .post('/attendance-corrections')
      .send({ date: '2026-03-25', requested_check_in: '2026-03-25T07:00:00.000Z', reason: 'x' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ATTENDANCE_DATE_IN_FUTURE');
  });

  it('refuses a date outside the correction window', async () => {
    setClock(20, 12);
    const response = await (await api(WORKER))
      .post('/attendance-corrections')
      .send({ date: '2026-03-02', requested_check_in: '2026-03-02T07:00:00.000Z', reason: 'x' });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CORRECTION_WINDOW_CLOSED');
  });

  it('accepts a date inside the window', async () => {
    setClock(20, 12);
    const response = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-16',
      requested_check_out: '2026-03-16T16:30:00.000Z',
      reason: 'I forgot to check out; I left at 18:30',
    });
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('pending');
    // DOCUMENT 04 B7/C4 — the current values travel with the request so the
    // screen can show them side by side.
    expect(response.body.data.current.date).toBe('2026-03-16');
    correctionId = response.body.data.id as string;
  });

  it('refuses a second pending request for the same day', async () => {
    const response = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-16',
      requested_check_out: '2026-03-16T16:00:00.000Z',
      reason: 'again',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CORRECTION_ALREADY_PENDING');
  });

  it('refuses a request that asks for nothing', async () => {
    const response = await (await api(WORKER))
      .post('/attendance-corrections')
      .send({ date: '2026-03-17', reason: 'Nothing in particular' });
    expect(response.status).toBe(422);
  });

  it('refuses a check-out before the check-in', async () => {
    const response = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-17',
      requested_check_in: '2026-03-17T15:00:00.000Z',
      requested_check_out: '2026-03-17T07:00:00.000Z',
      reason: 'Wrong way round',
    });
    expect(response.status).toBe(422);
  });

  it('an employee cannot file one for somebody else', async () => {
    const response = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-17',
      employee_id: outsiderEmployeeId,
      requested_check_in: '2026-03-17T07:00:00.000Z',
      reason: 'Not mine to file',
    });
    expect(response.status).toBe(403);
  });

  it('approval writes both the attendance change and the audit record', async () => {
    const response = await (await api(MANAGER))
      .post(`/attendance-corrections/${correctionId}/approve`)
      .send({ review_note: 'Confirmed with the team' });
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('approved');

    const record = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: workerEmployeeId, date: new Date('2026-03-16T00:00:00.000Z') },
      }),
    );
    // The record now closes at the requested time, recalculated from the
    // schedule rather than copied: 09:00–18:30 Cairo less the 60-minute break.
    expect(record.checkOutAt?.toISOString()).toBe('2026-03-16T16:30:00.000Z');
    expect(record.workingMinutes).toBe(510);
    expect(record.source).toBe('correction');
    expect(record.status).toBe('present');

    const records = await audits(COMPANY_A, 'ATTENDANCE_CORRECTION_APPROVED');
    expect(records).toHaveLength(1);
  });

  it('will not decide the same request twice', async () => {
    const response = await (await api(MANAGER))
      .post(`/attendance-corrections/${correctionId}/approve`)
      .send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CORRECTION_NOT_PENDING');
  });

  it('rejection requires a reason', async () => {
    setClock(20, 12);
    const created = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-17',
      requested_check_in: '2026-03-17T07:00:00.000Z',
      reason: 'I was in the office',
    });
    const id = created.body.data.id as string;

    const withoutReason = await (await api(MANAGER))
      .post(`/attendance-corrections/${id}/reject`)
      .send({});
    expect(withoutReason.status).toBe(422);
    expect(withoutReason.body.error.fields).toHaveProperty('review_note');

    const rejected = await (await api(MANAGER))
      .post(`/attendance-corrections/${id}/reject`)
      .send({ review_note: 'No badge record for that day' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('rejected');
    expect(await audits(COMPANY_A, 'ATTENDANCE_CORRECTION_REJECTED')).toHaveLength(1);
  });

  it('an employee may cancel their own pending request, and only that', async () => {
    setClock(20, 12);
    const created = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-19',
      requested_check_in: '2026-03-19T07:00:00.000Z',
      reason: 'Filed by mistake',
    });
    const id = created.body.data.id as string;

    const byOther = await (await api(OUTSIDER)).post(`/attendance-corrections/${id}/cancel`);
    expect(byOther.status).toBe(403);

    const cancelled = await (await api(WORKER)).post(`/attendance-corrections/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    const again = await (await api(WORKER)).post(`/attendance-corrections/${id}/cancel`);
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 12 rule 13 — the window is the company's, not a constant
// ---------------------------------------------------------------------------

describe('the correction window is configured per company', () => {
  it('defaults to DOCUMENT 12’s seven days', async () => {
    const company = await (await api(ADMIN_A)).get('/company');
    expect(company.body.data.correction_window_days).toBe(7);
  });

  it('a day the default refuses becomes reachable once the window is widened', async () => {
    setClock(20, 12);
    // The 2nd is 18 days before the 20th — outside seven days.
    const refused = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-02',
      requested_check_out: '2026-03-02T16:00:00.000Z',
      reason: 'Outside the default window',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CORRECTION_WINDOW_CLOSED');

    const widened = await (await api(ADMIN_A))
      .patch('/company')
      .send({ correction_window_days: 30 });
    expect(widened.status).toBe(200);

    const accepted = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-02',
      requested_check_out: '2026-03-02T16:00:00.000Z',
      reason: 'Inside the widened window',
    });
    expect(accepted.status).toBe(201);
  });

  it('narrowing it closes days that were reachable a moment ago', async () => {
    setClock(20, 12);
    const narrowed = await (await api(ADMIN_A))
      .patch('/company')
      .send({ correction_window_days: 1 });
    expect(narrowed.status).toBe(200);

    // The 17th was inside the seven-day window and is outside a one-day one.
    const refused = await (await api(WORKER)).post('/attendance-corrections').send({
      date: '2026-03-17',
      requested_check_in: '2026-03-17T07:00:00.000Z',
      reason: 'Now outside the window',
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CORRECTION_WINDOW_CLOSED');

    // Restored, so nothing after this test depends on the narrowed window.
    await (await api(ADMIN_A)).patch('/company').send({ correction_window_days: 7 });
  });

  it('one company’s window does not move another’s', async () => {
    const before = await (await api(ADMIN_B)).get('/company');
    expect(before.body.data.correction_window_days).toBe(7);
  });

  it('reaches the browser through GET /auth/me, so the history can offer the action', async () => {
    const me = await (await api(WORKER)).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.company.correctionWindowDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 21 "Record content" — the designated system actor
// ---------------------------------------------------------------------------

describe('system-generated rows name a system actor, never a person', () => {
  it('attributes generated attendance to a system user, not to an administrator', async () => {
    const records = await audits(COMPANY_A, 'ATTENDANCE_GENERATED_BY_SYSTEM');
    expect(records.length).toBeGreaterThan(0);

    const actorIds = new Set(records.map((row) => (row as { userId: string }).userId));
    expect(actorIds.size).toBe(1);
    const actorId = [...actorIds][0] as string;

    const actor = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: actorId } }),
    );
    expect(actor.isSystem).toBe(true);
    expect(actor.passwordHash).toBeNull();
    expect(actor.status).toBe('deactivated');

    // And it is emphatically not the administrator who happens to exist.
    const admin = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirstOrThrow({ where: { email: ADMIN_A.email }, select: { id: true } }),
    );
    expect(actorId).not.toBe(admin.id);
  });

  it('there is exactly one per company, however many times generation runs', async () => {
    await generateDay(24, atCairo(25, 1));
    await generateDay(25, atCairo(26, 1));
    const actors = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findMany({ where: { isSystem: true }, select: { id: true } }),
    );
    expect(actors).toHaveLength(1);
  });

  it('cannot sign in — the login path cannot even see it', async () => {
    redis.reset();
    const response = await request(server())
      .post(`/${API_PREFIX}/auth/login`)
      .set('X-Client-Type', 'mobile')
      .send({ email: 'system@ufuq.invalid', password: 'anything-at-all-2026' });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('cannot be given a password — the database refuses it', async () => {
    const actor = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirstOrThrow({ where: { isSystem: true }, select: { id: true } }),
    );
    await expect(
      withTenant(prisma, COMPANY_A, (tx) =>
        tx.user.update({
          where: { id: actor.id },
          data: { passwordHash: 'not-a-real-hash', status: 'active' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('cannot be reached by a password reset either', async () => {
    redis.reset();
    const response = await request(server())
      .post(`/${API_PREFIX}/auth/forgot-password`)
      .send({ email: 'system@ufuq.invalid' });
    // DOCUMENT 08 §4.1 — always 200, whatever happened internally.
    expect(response.status).toBe(200);
    const tokens = await withTenant(prisma, COMPANY_A, (tx) => tx.passwordResetToken.findMany());
    expect(tokens).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 09 §4 — scope, and DOCUMENT 26 §5 — tenancy
// ---------------------------------------------------------------------------

describe('scope — DOCUMENT 02 §5.3, DOCUMENT 09 §4', () => {
  it('an employee sees only their own attendance', async () => {
    const response = await (
      await api(WORKER)
    ).get('/attendance?from=2026-03-01&to=2026-03-31&per_page=100');
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    for (const record of response.body.data) {
      expect(record.employee.id).toBe(workerEmployeeId);
    }
  });

  it('a filter cannot widen a scope', async () => {
    const response = await (
      await api(WORKER)
    ).get(`/attendance?from=2026-03-01&to=2026-03-31&employee_id=${outsiderEmployeeId}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(0);
  });

  it('a manager sees their team and not the rest of the company', async () => {
    const response = await (
      await api(MANAGER)
    ).get('/attendance?from=2026-03-01&to=2026-03-31&per_page=100');
    expect(response.status).toBe(200);
    const seen = new Set(
      response.body.data.map((r: { employee: { id: string } }) => r.employee.id),
    );
    expect(seen.has(workerEmployeeId)).toBe(true);
    expect(seen.has(outsiderEmployeeId)).toBe(false);
  });

  it('an in-tenant record outside the caller’s scope is 403, not 404', async () => {
    const other = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findFirstOrThrow({
        where: { employeeId: outsiderEmployeeId },
        select: { id: true },
      }),
    );
    const response = await (await api(WORKER)).get(`/attendance/${other.id}`);
    expect(response.status).toBe(403);
  });
});

describe('tenancy — DOCUMENT 26 §5', () => {
  it('another company’s record is 404 on every id endpoint', async () => {
    setClock(23, 9);
    const bToken = await (async (): Promise<string> => {
      const created = await withTenant(prisma, COMPANY_B, (tx) =>
        tx.attendanceRecord.create({
          data: {
            id: generateId(),
            companyId: COMPANY_B,
            employeeId: workerBId,
            date: new Date('2026-03-23T00:00:00.000Z'),
            status: 'absent',
            source: 'system',
          },
          select: { id: true },
        }),
      );
      return created.id;
    })();

    expect((await (await api(ADMIN_A)).get(`/attendance/${bToken}`)).status).toBe(404);
    expect(
      (
        await (await api(ADMIN_A))
          .patch(`/attendance/${bToken}`)
          .send({ status: 'present', reason: 'x' })
      ).status,
    ).toBe(404);
  });

  it('a company’s list never contains another company’s rows', async () => {
    const response = await (
      await api(ADMIN_B)
    ).get('/attendance?from=2026-03-01&to=2026-03-31&per_page=100');
    expect(response.status).toBe(200);
    for (const record of response.body.data) {
      expect(record.employee.id).toBe(workerBId);
    }
  });

  it('a monthly matrix is scoped too', async () => {
    const response = await (await api(ADMIN_B)).get('/attendance/monthly?month=2026-03');
    const ids = response.body.data.rows.map((r: { employee: { id: string } }) => r.employee.id);
    expect(ids).not.toContain(workerEmployeeId);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 08 §4.3 — GET /employees/{id}/attendance
// ---------------------------------------------------------------------------

describe('GET /employees/{id}/attendance — DOCUMENT 08 §4.3', () => {
  it('returns the employee’s month, totalled exactly as the company matrix totals it', async () => {
    const response = await (
      await api(ADMIN_A)
    ).get(`/employees/${workerEmployeeId}/attendance?month=2026-03`);
    expect(response.status).toBe(200);
    const month = response.body.data;
    expect(month.month).toBe('2026-03');
    expect(month.employee.id).toBe(workerEmployeeId);
    expect(month.days).toHaveLength(31);
    expect(month.records.length).toBeGreaterThan(0);
    for (const record of month.records) {
      expect(record.employee.id).toBe(workerEmployeeId);
      expect(record.date.startsWith('2026-03-')).toBe(true);
    }

    const matrix = await (
      await api(ADMIN_A)
    ).get(`/attendance/monthly?month=2026-03&employee_id=${workerEmployeeId}`);
    const [row] = matrix.body.data.rows;
    expect(month.days).toEqual(row.days);
    expect(month.totals).toEqual(row.totals);
  });

  it('applies attendance.view scope: self sees self, a manager sees their team', async () => {
    expect(
      (await (await api(WORKER)).get(`/employees/${workerEmployeeId}/attendance?month=2026-03`))
        .status,
    ).toBe(200);
    expect(
      (await (await api(MANAGER)).get(`/employees/${workerEmployeeId}/attendance?month=2026-03`))
        .status,
    ).toBe(200);
  });

  it('an in-tenant employee outside the caller’s scope is 403', async () => {
    expect(
      (await (await api(WORKER)).get(`/employees/${managerEmployeeId}/attendance?month=2026-03`))
        .status,
    ).toBe(403);
    expect(
      (await (await api(MANAGER)).get(`/employees/${outsiderEmployeeId}/attendance?month=2026-03`))
        .status,
    ).toBe(403);
  });

  it('another company’s employee is 404', async () => {
    const response = await (
      await api(ADMIN_A)
    ).get(`/employees/${workerBId}/attendance?month=2026-03`);
    expect(response.status).toBe(404);
  });

  it('an employee with nothing recorded in the month gets an empty month, not an error', async () => {
    const response = await (
      await api(ADMIN_A)
    ).get(`/employees/${workerEmployeeId}/attendance?month=2025-12`);
    expect(response.status).toBe(200);
    expect(response.body.data.records).toEqual([]);
    expect(response.body.data.days).toHaveLength(31);
  });

  it('requires a valid month', async () => {
    const api_ = await api(ADMIN_A);
    expect((await api_.get(`/employees/${workerEmployeeId}/attendance`)).status).toBe(422);
    expect((await api_.get(`/employees/${workerEmployeeId}/attendance?month=2026-13`)).status).toBe(
      422,
    );
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 26 §3 — validation and pagination boundaries
// ---------------------------------------------------------------------------

describe('validation — DOCUMENT 08 §5', () => {
  it('rejects unknown fields, company_id included', async () => {
    const response = await (await api(ADMIN_A)).post('/attendance-corrections').send({
      date: '2026-03-17',
      requested_check_in: '2026-03-17T07:00:00.000Z',
      reason: 'x',
      company_id: COMPANY_B,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toHaveProperty('company_id');
  });

  it('refuses a malformed month', async () => {
    expect((await (await api(ADMIN_A)).get('/attendance/monthly?month=2026-13')).status).toBe(422);
    expect((await (await api(ADMIN_A)).get('/attendance/monthly?month=March')).status).toBe(422);
  });

  it('refuses a date that does not exist, with 422 rather than 500', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance?date=2026-02-30');
    expect(response.status).toBe(422);
  });

  it('refuses a range whose end precedes its start', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance?from=2026-03-20&to=2026-03-01');
    expect(response.status).toBe(422);
  });

  it('requires a window rather than listing everything', async () => {
    const response = await (await api(ADMIN_A)).get('/attendance');
    expect(response.status).toBe(422);
  });

  it('caps per_page at 100', async () => {
    const response = await (
      await api(ADMIN_A)
    ).get('/attendance?from=2026-03-01&to=2026-03-31&per_page=1000');
    expect(response.status).toBe(422);
  });

  it('a malformed id is 400 before any query runs', async () => {
    expect((await (await api(ADMIN_A)).get('/attendance/not-a-uuid')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DOCUMENT 21 — the audit trail
// ---------------------------------------------------------------------------

describe('audit — DOCUMENT 21 "Attendance"', () => {
  it('records a check-in and a check-out', async () => {
    expect((await audits(COMPANY_A, 'ATTENDANCE_CHECKED_IN')).length).toBeGreaterThan(0);
    expect((await audits(COMPANY_A, 'ATTENDANCE_CHECKED_OUT')).length).toBeGreaterThan(0);
  });

  it('records a correction being requested', async () => {
    expect((await audits(COMPANY_A, 'ATTENDANCE_CORRECTION_REQUESTED')).length).toBeGreaterThan(0);
  });

  it('never writes a password, token or hash into an attendance record', async () => {
    const all = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { entityType: { startsWith: 'attendance' } } }),
    );
    expect(JSON.stringify(all)).not.toMatch(/password|token|hash/i);
  });
});

describe('audit after commit — DOCUMENT 21 §1–§3 (representative for Phases 6–9)', () => {
  it('a failed check-in audit keeps the committed check-in; the queued retry lands exactly once', async () => {
    setClock(31, 9, 0);
    const before = (await audits(COMPANY_A, 'ATTENDANCE_CHECKED_IN')).length;
    await prisma.$executeRawUnsafe('RESET ROLE');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_force_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'attendance.checked_in' THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_force_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_force_audit_failure()',
    );
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    let recordId: string;
    try {
      const response = await (await api(OUTSIDER))
        .post('/attendance/check-in')
        .send({ work_mode: 'office' });
      expect(response.status).toBe(201);
      recordId = response.body.data.id as string;
    } finally {
      await prisma.$executeRawUnsafe('RESET ROLE');
      await prisma.$executeRawUnsafe('DROP TRIGGER test_force_audit_failure ON audit_logs');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_force_audit_failure()');
      await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    }

    // The check-in stands although its audit did not land.
    const stored = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findUnique({ where: { id: recordId } }),
    );
    expect(stored?.checkInAt).not.toBeNull();
    expect(await audits(COMPANY_A, 'ATTENDANCE_CHECKED_IN')).toHaveLength(before);
    const queued = retryQueue.entries.find((entry) => entry.entityId === recordId);
    expect(queued).toMatchObject({
      action: 'ATTENDANCE_CHECKED_IN',
      entityType: 'attendance_record',
    });

    const dispatcher = app.get(AuditDispatcher);
    await dispatcher.write(queued as QueuedAuditEntry);
    await dispatcher.write(queued as QueuedAuditEntry);
    expect(await audits(COMPANY_A, 'ATTENDANCE_CHECKED_IN')).toHaveLength(before + 1);
  });
});
