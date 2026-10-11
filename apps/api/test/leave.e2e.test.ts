/**
 * Phase 10 end-to-end — DOCUMENT 25 Phase 10, DOCUMENT 16, DOCUMENT 08 §4.6,
 * OD-03, OD-09, OD-11 and OD-16 (approved), DOCUMENT 26.
 *
 * Exit criterion: *"approving leave produces correct attendance records and
 * correct balances, and all the conflict cases in DOCUMENT 16 are blocked"* —
 * and, by the Phase 9 roadmap amendment, Leave participates fully in the
 * Requests Centre. Proved here over HTTP, with forced failures proving that
 * approval is one transaction.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced (the connection runs as `ufuq_app`). Redis, mail, object
 * storage and the event sinks are fakes. `Date` is fixed at Tuesday
 * 2026-03-10, 10:00 Cairo; the schedule works Sunday–Thursday.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import { Decimal } from '@ufuq/money';
import type { AuditAction, PrismaClient } from '@ufuq/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import { AttendanceGenerationService } from '../src/attendance/attendance-generation.service.js';
import { parseCalendarDate } from '../src/attendance/zoned-time.js';
import type { CalendarDate } from '../src/attendance/zoned-time.js';
import { AUDIT_RETRY_QUEUE, AuditDispatcher } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { LeaveCarryOverService } from '../src/leave/leave-carry-over.service.js';
import { LEAVE_EVENT_SINK } from '../src/leave/leave-events.js';
import type { LeaveEvent, LeaveEventSink } from '../src/leave/leave-events.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { PDF_MIME, SAMPLES } from './attachment-samples.js';
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

class CapturingSink implements LeaveEventSink {
  readonly events: LeaveEvent[] = [];
  handle(event: LeaveEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
const sink = new CapturingSink();

/** Stands in for the BullMQ retry queue (no Redis here); `failing` simulates the queue being down too. */
class CapturingRetryQueue implements AuditRetryQueue {
  readonly entries: QueuedAuditEntry[] = [];
  failing = false;
  enqueue(entry: QueuedAuditEntry): Promise<void> {
    if (this.failing) return Promise.reject(new Error('retry queue unavailable'));
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
const OUTSIDER = { email: 'outsider@a.test', password: 'outsider-password-2026' };
const WORKER_B = { email: 'worker@b.test', password: 'worker-b-password-2026' };

let managerEmployeeId = '';
let workerEmployeeId = '';
let worker2EmployeeId = '';
let outsiderEmployeeId = '';
let newcomerEmployeeId = '';
const types: Record<string, string> = {};

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

/** Tuesday 2026-03-10, 10:00 in Cairo (UTC+2 in March). */
const NOW = new Date(Date.UTC(2026, 2, 10, 8, 0, 0));

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

/** Sunday–Thursday working, Friday and Saturday rest — as data, never code. */
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
    .useValue(sink)
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

  const admin = await api(ADMIN_A);
  const schedule = await admin.post('/work-schedules').send({
    name: 'Standard week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  const scheduleId = schedule.body.data.id as string;

  await createEmployee(ADMIN_A, {
    first_name: 'Hala',
    last_name: 'Kamal',
    email: ADMIN_EMP.email,
    employee_code: 'ADM-1',
    role_key: 'admin',
    work_schedule_id: scheduleId,
  });
  managerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Mona',
    last_name: 'Saleh',
    email: MANAGER.email,
    employee_code: 'MGR-1',
    role_key: 'manager',
    work_schedule_id: scheduleId,
  });
  workerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Omar',
    last_name: 'Fathy',
    email: WORKER.email,
    employee_code: 'EMP-1',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  worker2EmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Sara',
    last_name: 'Adel',
    email: WORKER2.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  outsiderEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Layla',
    last_name: 'Nabil',
    email: OUTSIDER.email,
    employee_code: 'EMP-3',
    role_key: 'employee',
    work_schedule_id: scheduleId,
  });
  newcomerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Nour',
    last_name: 'Hassan',
    email: 'newcomer@a.test',
    employee_code: 'EMP-4',
    role_key: 'employee',
    work_schedule_id: scheduleId,
    joining_date: '2026-03-01',
  });
  for (const account of [ADMIN_EMP, MANAGER, WORKER, WORKER2, OUTSIDER]) {
    await activate(account);
  }

  // The seeded types, configured the way an ADMIN would (allowances start at 0).
  const listed = await admin.get('/leave-types');
  for (const type of listed.body.data as { id: string; name_en: string }[]) {
    types[type.name_en] = type.id;
  }
  expect(
    (
      await admin
        .patch(`/leave-types/${types['Annual'] as string}`)
        .send({ default_days_per_year: '14' })
    ).status,
  ).toBe(200);
  expect(
    (
      await admin
        .patch(`/leave-types/${types['Sick'] as string}`)
        .send({ default_days_per_year: '10' })
    ).status,
  ).toBe(200);
  expect(
    (
      await admin
        .patch(`/leave-types/${types['Emergency'] as string}`)
        .send({ default_days_per_year: '5' })
    ).status,
  ).toBe(200);
  const flexible = await admin.post('/leave-types').send({
    name_ar: 'مرنة',
    name_en: 'Flexible',
    is_paid: true,
    default_days_per_year: '2',
    requires_attachment: false,
    allows_negative_balance: true,
    carry_over_policy: 'full',
  });
  expect(flexible.status).toBe(201);
  types['Flexible'] = flexible.body.data.id as string;

  const adminB = await api(ADMIN_B);
  const scheduleB = await adminB.post('/work-schedules').send({
    name: 'B week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  await createEmployee(ADMIN_B, {
    first_name: 'Other',
    last_name: 'Person',
    email: WORKER_B.email,
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB.body.data.id as string,
  });
  await activate(WORKER_B);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await socket.stop();
  await pglite.close();
});

beforeEach(() => {
  sink.events.length = 0;
});

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
    delete: (path: string) => auth(agent.delete(`/${API_PREFIX}${path}`)),
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

interface Balance {
  readonly id: string;
  readonly year: number;
  readonly leave_type: { id: string; name_en: string };
  readonly total_days: string;
  readonly used_days: string;
  readonly pending_days: string;
  readonly carried_over_days: string;
  readonly remaining_days: string;
}

interface Leave {
  readonly id: string;
  readonly status: string;
  readonly days_count: string;
  readonly year_allocation: Record<string, string>;
  readonly start_date: string;
  readonly end_date: string;
  readonly review_note: string | null;
  readonly attachment: { id: string } | null;
  readonly balances: Balance[];
  readonly holidays_inside: string[];
  readonly warnings?: string[];
  readonly excess_days?: string;
  readonly abilities: { can_review: boolean; can_cancel: boolean; can_cancel_approved: boolean };
}

function typeOf(name: string): string {
  const id = types[name];
  if (id === undefined) throw new Error(`No type ${name}`);
  return id;
}

async function submit(
  account: Account,
  body: { type: string; start: string; end: string; reason?: string },
) {
  return (await api(account)).post('/leave-requests').send({
    leave_type_id: typeOf(body.type),
    start_date: body.start,
    end_date: body.end,
    reason: body.reason ?? 'Family matters',
  });
}

async function submitted(
  account: Account,
  body: { type: string; start: string; end: string },
): Promise<Leave> {
  const response = await submit(account, body);
  if (response.status !== 201) {
    throw new Error(`Leave submit failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as Leave;
}

async function leave(id: string, account: Account = ADMIN_A): Promise<Leave> {
  const response = await (await api(account)).get(`/leave-requests/${id}`);
  expect(response.status).toBe(200);
  return response.body.data as Leave;
}

async function act(
  account: Account,
  id: string,
  action: 'approve' | 'reject' | 'cancel',
  body: Record<string, unknown> = {},
) {
  return (await api(account)).post(`/leave-requests/${id}/${action}`).send(body);
}

/** A balance read the way an ADMIN reads it — no side effect beyond writing a missing row. */
async function balanceOf(employeeId: string, type: string, year = 2026): Promise<Balance> {
  const response = await (await api(ADMIN_A))
    .get('/leave-balances')
    .query({ employee_id: employeeId, year: String(year), per_page: '100' });
  expect(response.status).toBe(200);
  const row = (response.body.data as Balance[]).find((b) => b.leave_type.id === typeOf(type));
  if (row === undefined) throw new Error(`No ${type} balance for ${employeeId} in ${String(year)}`);
  return row;
}

async function leaveDays(leaveId: string) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.attendanceRecord.findMany({
      where: { leaveRequestId: leaveId },
      orderBy: { date: 'asc' },
      select: { date: true, status: true, source: true },
    }),
  );
}

async function inboxRow(leaveId: string) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.request.findFirst({ where: { relatedType: 'leave_request', relatedId: leaveId } }),
  );
}

async function auditsFor(entityType: string, entityId: string, action: AuditAction) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({
      where: { entityType, entityId, action },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function asOwner<T>(run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('RESET ROLE');
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
  }
}

function dates(rows: readonly { date: Date }[]): string[] {
  return rows.map((row) => row.date.toISOString().slice(0, 10));
}

// ---------------------------------------------------------------------------
// Leave types — DOCUMENT 16 "Data", B25
// ---------------------------------------------------------------------------

describe('leave types — seeded, configurable, audited', () => {
  it('every company starts with the five documented types; ADMINs configure them', async () => {
    const admin = await api(ADMIN_A);
    const listed = (await admin.get('/leave-types')).body.data as {
      name_en: string;
      default_days_per_year: string;
    }[];
    expect(listed.map((t) => t.name_en)).toEqual(
      expect.arrayContaining(['Annual', 'Sick', 'Emergency', 'Unpaid', 'Other', 'Flexible']),
    );
    expect(listed.find((t) => t.name_en === 'Annual')?.default_days_per_year).toBe('14.00');
    const updates = await auditsFor('leave_type', typeOf('Annual'), 'LEAVE_TYPE_UPDATED');
    expect(updates[0]?.oldValues).toEqual({ default_days_per_year: '0.00' });
    expect(updates[0]?.newValues).toEqual({ default_days_per_year: '14.00' });
    expect(await auditsFor('leave_type', typeOf('Flexible'), 'LEAVE_TYPE_CREATED')).toHaveLength(1);
    // Company B has its own five, and never sees A's.
    const b = (await (await api(ADMIN_B)).get('/leave-types')).body.data as { id: string }[];
    expect(b).toHaveLength(5);
    expect(b.some((t) => t.id === typeOf('Annual'))).toBe(false);
  });

  it('a capped policy needs a cap; employees read active types and configure nothing', async () => {
    const admin = await api(ADMIN_A);
    const noCap = await admin
      .patch(`/leave-types/${typeOf('Other')}`)
      .send({ carry_over_policy: 'capped' });
    expect(noCap.body.error.fields.carry_over_cap).toEqual(['required']);
    const worker = await api(WORKER);
    expect((await worker.get('/leave-types')).status).toBe(200);
    expect((await worker.post('/leave-types').send({})).status).toBe(403);
    expect(
      (await worker.patch(`/leave-types/${typeOf('Other')}`).send({ default_days_per_year: '9' }))
        .status,
    ).toBe(403);
    // Allowances travel as strings, never JSON numbers.
    expect(
      (await admin.patch(`/leave-types/${typeOf('Other')}`).send({ default_days_per_year: 3 }))
        .status,
    ).toBe(422);
  });

  it('a retired type takes no new requests and leaves the list', async () => {
    const admin = await api(ADMIN_A);
    const created = await admin.post('/leave-types').send({
      name_ar: 'مؤقتة',
      name_en: 'Temporary',
      is_paid: true,
      default_days_per_year: '1',
      requires_attachment: false,
      allows_negative_balance: false,
      carry_over_policy: 'none',
    });
    const id = created.body.data.id as string;
    expect((await admin.delete(`/leave-types/${id}`)).status).toBe(200);
    const active = (await (await api(WORKER)).get('/leave-types')).body.data as { id: string }[];
    expect(active.some((t) => t.id === id)).toBe(false);
    const refused = await (await api(WORKER)).post('/leave-requests').send({
      leave_type_id: id,
      start_date: '2026-09-06',
      end_date: '2026-09-06',
      reason: 'Testing',
    });
    expect(refused.body.error.fields.leave_type_id).toEqual(['not_found']);
  });
});

// ---------------------------------------------------------------------------
// Calculation — rule 2, OD-16
// ---------------------------------------------------------------------------

describe('calculation — the server counts the days', () => {
  async function calc(query: Record<string, string>, account: Account = WORKER) {
    return (await api(account)).get('/leave-requests/calculate').query(query);
  }

  it('counts the employee’s working days, excluding rest days and holidays', async () => {
    const week = await calc({
      start_date: '2026-03-15',
      end_date: '2026-03-21',
      leave_type_id: typeOf('Annual'),
    });
    expect(week.status).toBe(200);
    expect(week.body.data).toMatchObject({
      days_count: '5.00',
      dates: ['2026-03-15', '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19'],
      balance_impact: [
        { year: 2026, days: '5.00', remaining_before: '14.00', remaining_after: '9.00' },
      ],
      sufficient: true,
    });
    const holiday = await (await api(ADMIN_A))
      .post('/holidays')
      .send({ date: '2026-05-14', name_ar: 'عيد', name_en: 'Feast' });
    expect(holiday.status).toBe(201);
    const withHoliday = await calc({ start_date: '2026-05-10', end_date: '2026-05-14' });
    expect(withHoliday.body.data.days_count).toBe('4.00');
  });

  it('refuses an all-rest-day range, a reversed range and a start before joining', async () => {
    const weekend = await calc({ start_date: '2026-03-20', end_date: '2026-03-21' });
    expect(weekend.status).toBe(422);
    expect(weekend.body.error.code).toBe('LEAVE_NO_WORKING_DAYS');
    expect(
      (await calc({ start_date: '2026-03-19', end_date: '2026-03-18' })).body.error.fields.end_date,
    ).toEqual(['end_before_start']);
    expect(
      (await calc({ start_date: '2026-01-01', end_date: '2026-01-06' })).body.error.fields
        .start_date,
    ).toEqual(['before_joining']);
  });

  it('a mid-year joiner’s allowance is pro-rated by month worked (OD-16)', async () => {
    // Joined 1 March: 10 months of 14 days = 11.666… → 11.67.
    expect((await balanceOf(newcomerEmployeeId, 'Annual')).total_days).toBe('11.67');
    // A January joiner: the full allowance, and the next year too.
    expect((await balanceOf(workerEmployeeId, 'Annual')).total_days).toBe('14.00');
    expect((await balanceOf(newcomerEmployeeId, 'Annual', 2027)).total_days).toBe('14.00');
  });
});

// ---------------------------------------------------------------------------
// Submission and holds — rules 3, 6, 7, 9, 10, 11
// ---------------------------------------------------------------------------

describe('submission — the hold, and every conflict blocked', () => {
  it('holds the days, indexes the request in the centre, audits and publishes', async () => {
    const created = await submitted(WORKER, {
      type: 'Annual',
      start: '2026-03-15',
      end: '2026-03-17',
    });
    expect(created).toMatchObject({
      status: 'pending',
      days_count: '3.00',
      year_allocation: { '2026': '3.00' },
    });
    const balance = await balanceOf(workerEmployeeId, 'Annual');
    expect(balance).toMatchObject({
      pending_days: '3.00',
      used_days: '0.00',
      remaining_days: '11.00',
    });
    expect(await inboxRow(created.id)).toMatchObject({
      category: 'leave',
      status: 'pending',
      employeeId: workerEmployeeId,
    });
    expect(await auditsFor('leave_request', created.id, 'LEAVE_REQUESTED')).toHaveLength(1);
    expect(sink.events.map((e) => e.type)).toEqual(['leave_request_submitted']);
  });

  it('blocks overlapping leave, naming it', async () => {
    const overlap = await submit(WORKER, {
      type: 'Emergency',
      start: '2026-03-17',
      end: '2026-03-18',
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LEAVE_OVERLAP');
    expect(overlap.body.error.fields.conflicting_dates).toEqual(['2026-03-15/2026-03-17']);
  });

  it('blocks insufficient balance, saying how much is left', async () => {
    const tooMuch = await submit(WORKER, {
      type: 'Annual',
      start: '2026-06-01',
      end: '2026-07-31',
    });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('LEAVE_INSUFFICIENT_BALANCE');
    expect(tooMuch.body.error.fields.remaining).toEqual(['11.00']);
    expect((await balanceOf(workerEmployeeId, 'Annual')).pending_days).toBe('3.00');
  });

  it('a type that allows a negative balance accepts the excess, warns, and never trims the days', async () => {
    const created = await submitted(WORKER, {
      type: 'Flexible',
      start: '2026-04-19',
      end: '2026-04-21',
    });
    expect(created.days_count).toBe('3.00');
    expect(created.warnings).toEqual(['exceeds_balance']);
    expect(created.excess_days).toBe('1.00');
    expect((await balanceOf(workerEmployeeId, 'Flexible')).remaining_days).toBe('-1.00');
  });

  it('unpaid leave holds and charges no balance (rule 7)', async () => {
    const created = await submitted(WORKER, {
      type: 'Unpaid',
      start: '2026-04-26',
      end: '2026-04-27',
    });
    expect(created.balances).toEqual([]);
    const all = await (await api(ADMIN_A))
      .get('/leave-balances')
      .query({ employee_id: workerEmployeeId });
    expect((all.body.data as Balance[]).some((b) => b.leave_type.id === typeOf('Unpaid'))).toBe(
      false,
    );
  });

  it('a required attachment is enforced, stored privately with the request, and scoped', async () => {
    const missing = await submit(WORKER, { type: 'Sick', start: '2026-04-05', end: '2026-04-06' });
    expect(missing.body.error.fields.file).toEqual(['required']);
    redis.reset();
    const withFile = await (await api(WORKER))
      .post('/leave-requests')
      .field('leave_type_id', typeOf('Sick'))
      .field('start_date', '2026-04-05')
      .field('end_date', '2026-04-06')
      .field('reason', 'Doctor’s note attached')
      .attach('file', SAMPLES.pdf.bytes, { filename: 'note.pdf', contentType: PDF_MIME });
    expect(withFile.status).toBe(201);
    const fileId = (withFile.body.data as Leave).attachment?.id as string;
    expect(fileId).toBeDefined();
    // Audited after the submission committed, with the request's own record.
    expect(await auditsFor('attachment', fileId, 'ATTACHMENT_UPLOADED')).toHaveLength(1);
    expect((await (await api(MANAGER)).get(`/attachments/${fileId}`)).status).toBe(200);
    expect((await (await api(OUTSIDER)).get(`/attachments/${fileId}`)).status).toBe(404);
    expect((await (await api(ADMIN_B)).get(`/attachments/${fileId}`)).status).toBe(404);
    // A disguised file is refused by the same checks as /attachments.
    redis.reset();
    const disguised = await (await api(WORKER))
      .post('/leave-requests')
      .field('leave_type_id', typeOf('Sick'))
      .field('start_date', '2026-04-08')
      .field('end_date', '2026-04-08')
      .field('reason', 'Another note')
      .attach('file', SAMPLES.png.bytes, { filename: 'note.pdf', contentType: PDF_MIME });
    expect(disguised.body.error.fields.file).toEqual(['unsupported_type']);
  });

  it('a day already worked (checked in) cannot be taken as leave', async () => {
    expect(
      (await (await api(WORKER)).post('/attendance/check-in').send({ work_mode: 'office' })).status,
    ).toBe(201);
    const conflict = await submit(WORKER, {
      type: 'Annual',
      start: '2026-03-10',
      end: '2026-03-10',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('LEAVE_ATTENDANCE_CONFLICT');
    expect(conflict.body.error.fields.conflicting_dates).toEqual(['2026-03-10']);
  });

  it('never accepts a day count, an owner or a status from the client', async () => {
    for (const extra of [
      { days_count: '1' },
      { employee_id: outsiderEmployeeId },
      { status: 'approved' },
    ]) {
      const response = await (await api(WORKER)).post('/leave-requests').send({
        leave_type_id: typeOf('Emergency'),
        start_date: '2026-09-06',
        end_date: '2026-09-06',
        reason: 'Errand',
        ...extra,
      });
      expect(response.status).toBe(422);
    }
    const short = await submit(WORKER, {
      type: 'Emergency',
      start: '2026-09-06',
      end: '2026-09-06',
      reason: 'no',
    });
    expect(short.body.error.fields.reason).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Approval — rules 4 and 5, OD-03
// ---------------------------------------------------------------------------

describe('approval — one transaction', () => {
  it('moves the hold to used, writes linked on_leave days, syncs the centre, audits, publishes', async () => {
    const pending = (
      (
        await (await api(MANAGER))
          .get('/leave-requests')
          .query({ employee_id: workerEmployeeId, status: 'pending' })
      ).body.data as Leave[]
    ).find((l) => l.start_date === '2026-03-15') as Leave;
    expect(pending.abilities.can_review).toBe(true);
    sink.events.length = 0;
    const approved = await act(MANAGER, pending.id, 'approve', { review_note: 'Enjoy' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', review_note: 'Enjoy' });
    expect(await balanceOf(workerEmployeeId, 'Annual')).toMatchObject({
      pending_days: '0.00',
      used_days: '3.00',
      remaining_days: '11.00',
    });
    const days = await leaveDays(pending.id);
    expect(dates(days)).toEqual(['2026-03-15', '2026-03-16', '2026-03-17']);
    expect(days.every((d) => d.status === 'on_leave' && d.source === 'system')).toBe(true);
    expect(await inboxRow(pending.id)).toMatchObject({
      status: 'approved',
      adminResponse: 'Enjoy',
    });
    expect(await auditsFor('leave_request', pending.id, 'LEAVE_APPROVED')).toHaveLength(1);
    expect(sink.events.map((e) => e.type)).toEqual(['leave_approved']);
    const again = await act(ADMIN_A, pending.id, 'approve');
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('LEAVE_NOT_PENDING');
  });

  it('a leave spanning two months writes each day on its own date', async () => {
    const created = await submitted(WORKER, {
      type: 'Annual',
      start: '2026-03-29',
      end: '2026-04-02',
    });
    expect((await act(MANAGER, created.id, 'approve')).status).toBe(200);
    expect(dates(await leaveDays(created.id))).toEqual([
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ]);
  });

  it('a leave spanning two years charges each year’s balance its own portion', async () => {
    const created = await submitted(WORKER, {
      type: 'Annual',
      start: '2026-12-27',
      end: '2027-01-07',
    });
    expect(created.year_allocation).toEqual({ '2026': '5.00', '2027': '5.00' });
    expect((await balanceOf(workerEmployeeId, 'Annual', 2026)).pending_days).toBe('5.00');
    expect((await balanceOf(workerEmployeeId, 'Annual', 2027)).pending_days).toBe('5.00');
    expect((await act(MANAGER, created.id, 'approve')).status).toBe(200);
    expect(await balanceOf(workerEmployeeId, 'Annual', 2026)).toMatchObject({
      pending_days: '0.00',
      used_days: '13.00',
    });
    expect(await balanceOf(workerEmployeeId, 'Annual', 2027)).toMatchObject({
      pending_days: '0.00',
      used_days: '5.00',
    });
    expect(await leaveDays(created.id)).toHaveLength(10);
  });

  it('nobody decides their own leave (OD-03); scope and tenant are enforced', async () => {
    const managers = await submitted(MANAGER, {
      type: 'Annual',
      start: '2026-04-12',
      end: '2026-04-13',
    });
    const own = await act(MANAGER, managers.id, 'approve');
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('REQUEST_SELF_REVIEW');
    const admins = await submitted(ADMIN_EMP, {
      type: 'Annual',
      start: '2026-04-12',
      end: '2026-04-13',
    });
    expect((await act(ADMIN_EMP, admins.id, 'reject', { review_note: 'x' })).body.error.code).toBe(
      'REQUEST_SELF_REVIEW',
    );
    expect((await act(ADMIN_A, managers.id, 'approve')).status).toBe(200);
    expect((await act(ADMIN_A, admins.id, 'approve')).status).toBe(200);

    const outsiders = await submitted(OUTSIDER, {
      type: 'Emergency',
      start: '2026-04-12',
      end: '2026-04-12',
    });
    expect((await act(MANAGER, outsiders.id, 'approve')).status).toBe(403);
    expect((await act(WORKER, outsiders.id, 'approve')).status).toBe(403);
    expect((await act(ADMIN_B, outsiders.id, 'approve')).status).toBe(404);
    expect((await (await api(ADMIN_B)).get(`/leave-requests/${outsiders.id}`)).status).toBe(404);
    expect((await (await api(WORKER)).get(`/leave-requests/${outsiders.id}`)).status).toBe(403);
    expect((await leave(outsiders.id)).status).toBe('pending');
  });

  it('two approvers at once: exactly one succeeds, the other gets 409', async () => {
    const created = await submitted(WORKER2, {
      type: 'Annual',
      start: '2026-06-14',
      end: '2026-06-15',
    });
    const results = await Promise.all([
      act(ADMIN_A, created.id, 'approve'),
      act(MANAGER, created.id, 'approve'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await balanceOf(worker2EmployeeId, 'Annual')).toMatchObject({
      used_days: '2.00',
      pending_days: '0.00',
    });
    expect(await leaveDays(created.id)).toHaveLength(2);
  });
});

describe('approval rolls back completely when any part fails', () => {
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

  async function expectUntouched(id: string): Promise<void> {
    expect((await leave(id)).status).toBe('pending');
    expect(await balanceOf(worker2EmployeeId, 'Annual')).toMatchObject({
      pending_days: '2.00',
      used_days: '2.00',
    });
    expect(await leaveDays(id)).toEqual([]);
    expect((await inboxRow(id))?.status).toBe('pending');
    expect(await auditsFor('leave_request', id, 'LEAVE_APPROVED')).toEqual([]);
  }

  it('an attendance write failing undoes the balance, the request and the centre row', async () => {
    const created = await submitted(WORKER2, {
      type: 'Annual',
      start: '2026-06-07',
      end: '2026-06-08',
    });
    sink.events.length = 0;
    await withFailingTrigger(
      'attendance_records',
      `NEW.leave_request_id = '${created.id}'::uuid`,
      async () => {
        expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(500);
      },
    );
    await expectUntouched(created.id);

    await withFailingTrigger(
      'leave_balances',
      `TG_OP = 'UPDATE' AND NEW.used_days <> OLD.used_days`,
      async () => {
        expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(500);
      },
    );
    await expectUntouched(created.id);
    // No event for a rolled-back change (DOCUMENT 19 rule 2).
    expect(sink.events).toEqual([]);

    expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Rejection and cancellation — rules 3, 8, 15
// ---------------------------------------------------------------------------

describe('rejection and cancellation release exactly the hold', () => {
  it('rejection needs a reason and releases the hold', async () => {
    const created = await submitted(WORKER, {
      type: 'Emergency',
      start: '2026-05-03',
      end: '2026-05-04',
    });
    expect((await balanceOf(workerEmployeeId, 'Emergency')).pending_days).toBe('2.00');
    expect((await act(MANAGER, created.id, 'reject', {})).status).toBe(422);
    const rejected = await act(MANAGER, created.id, 'reject', { review_note: 'Busy week' });
    expect(rejected.status).toBe(200);
    expect(await balanceOf(workerEmployeeId, 'Emergency')).toMatchObject({
      pending_days: '0.00',
      used_days: '0.00',
    });
    expect(await inboxRow(created.id)).toMatchObject({
      status: 'rejected',
      adminResponse: 'Busy week',
    });
    expect(await auditsFor('leave_request', created.id, 'LEAVE_REJECTED')).toHaveLength(1);
  });

  it('the requester cancels their own pending leave; nobody else does; approved is not self-cancelled', async () => {
    const created = await submitted(WORKER, {
      type: 'Emergency',
      start: '2026-05-17',
      end: '2026-05-18',
    });
    expect((await act(MANAGER, created.id, 'cancel')).status).toBe(403);
    expect((await act(OUTSIDER, created.id, 'cancel')).status).toBe(403);
    expect((await act(WORKER, created.id, 'cancel')).status).toBe(200);
    expect((await balanceOf(workerEmployeeId, 'Emergency')).pending_days).toBe('0.00');
    expect(await auditsFor('leave_request', created.id, 'LEAVE_CANCELLED')).toHaveLength(1);
    expect((await act(WORKER, created.id, 'cancel')).status).toBe(409);

    const approved = (
      (
        await (await api(WORKER))
          .get('/leave-requests')
          .query({ status: 'approved', per_page: '100' })
      ).body.data as Leave[]
    )[0] as Leave;
    expect(approved.abilities.can_cancel).toBe(false);
    expect((await act(WORKER, approved.id, 'cancel')).status).toBe(409);
  });

  it('an ADMIN cancels approved leave: balance back, every day kept and reconciled, none deleted', async () => {
    // Sunday 8 – Thursday 12 March: 8 and 9 have passed; 10 is today.
    const created = await submitted(OUTSIDER, {
      type: 'Annual',
      start: '2026-03-08',
      end: '2026-03-12',
    });
    expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(200);
    const approvedDays = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({
        where: { leaveRequestId: created.id },
        orderBy: { date: 'asc' },
      }),
    );
    expect(dates(approvedDays)).toHaveLength(5);
    expect((await balanceOf(outsiderEmployeeId, 'Annual')).used_days).toBe('5.00');

    expect((await act(MANAGER, created.id, 'cancel', { reason: 'x' })).status).toBe(403);
    expect((await act(ADMIN_A, created.id, 'cancel', {})).body.error.fields.reason).toEqual([
      'required',
    ]);
    const cancelled = await act(ADMIN_A, created.id, 'cancel', { reason: 'Recalled for audit' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(await balanceOf(outsiderEmployeeId, 'Annual')).toMatchObject({
      used_days: '0.00',
      remaining_days: '14.00',
    });
    // The leave relationship is fully reversed…
    expect(await leaveDays(created.id)).toEqual([]);
    // …and every row it wrote still exists, the same rows by id.
    const kept = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({
        where: { employeeId: outsiderEmployeeId, date: { gte: new Date('2026-03-08T00:00:00Z') } },
        orderBy: { date: 'asc' },
      }),
    );
    expect(kept.map((day) => day.id)).toEqual(approvedDays.map((day) => day.id));
    expect(kept.every((day) => day.leaveRequestId === null && day.checkInAt === null)).toBe(true);
    // Past working days: what the nightly job writes. Today and later: not
    // an absence yet (approved [DECISION REQUIRED]: `pending`).
    expect(kept.map((day) => [dates([day])[0], day.status])).toEqual([
      ['2026-03-08', 'absent'],
      ['2026-03-09', 'absent'],
      ['2026-03-10', 'pending'],
      ['2026-03-11', 'pending'],
      ['2026-03-12', 'pending'],
    ]);
    const audit = await auditsFor('leave_request', created.id, 'LEAVE_CANCELLED');
    expect(audit[0]?.newValues).toMatchObject({
      reason: 'Recalled for audit',
      reconciled_days: {
        '2026-03-08': 'absent',
        '2026-03-09': 'absent',
        '2026-03-10': 'pending',
        '2026-03-11': 'pending',
        '2026-03-12': 'pending',
      },
    });
    for (const day of kept) {
      expect(
        await auditsFor('attendance_record', day.id, 'ATTENDANCE_ADJUSTED_BY_ADMIN'),
      ).toHaveLength(1);
    }
    expect((await inboxRow(created.id))?.status).toBe('cancelled');

    // Today's reconciled day: checking in converts it like any generated row.
    const checkIn = await (await api(OUTSIDER))
      .post('/attendance/check-in')
      .send({ work_mode: 'office' });
    expect(checkIn.status).toBe(201);
    // Tomorrow's, once it has ended with nobody checking in, becomes absent.
    await app
      .get(AttendanceGenerationService)
      .generateRange(
        COMPANY_A,
        parseCalendarDate('2026-03-11') as CalendarDate,
        parseCalendarDate('2026-03-11') as CalendarDate,
        new Date(Date.UTC(2026, 2, 12, 8, 0, 0)),
      );
    const later = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({
        where: { id: { in: kept.map((day) => day.id) } },
        orderBy: { date: 'asc' },
      }),
    );
    // 10 March is now a real, open check-in (status `pending` until check-out).
    expect(
      later.map((day) => [dates([day])[0], day.status, day.source, day.checkInAt !== null]),
    ).toEqual([
      ['2026-03-08', 'absent', 'system', false],
      ['2026-03-09', 'absent', 'system', false],
      ['2026-03-10', 'pending', 'self', true],
      ['2026-03-11', 'absent', 'system', false],
      ['2026-03-12', 'pending', 'system', false],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Audit after commit (DOCUMENT 21 §1–§3) and the cancellation transaction
// ---------------------------------------------------------------------------

describe('leave audits are dispatched only after commit', () => {
  async function withForcedFailure(
    table: string,
    condition: string,
    run: () => Promise<void>,
  ): Promise<void> {
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_force_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF ${condition} THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER test_force_audit_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION test_force_audit_failure()`,
      );
    });
    try {
      await run();
    } finally {
      await asOwner(async () => {
        await prisma.$executeRawUnsafe(`DROP TRIGGER test_force_audit_failure ON ${table}`);
        await prisma.$executeRawUnsafe('DROP FUNCTION test_force_audit_failure()');
      });
    }
  }

  beforeEach(() => {
    retryQueue.entries.length = 0;
    retryQueue.failing = false;
  });

  it('a forced rollback of an approved-leave cancellation leaves everything, and writes no audit', async () => {
    const created = await submitted(OUTSIDER, {
      type: 'Annual',
      start: '2026-04-05',
      end: '2026-04-06',
    });
    expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(200);
    const before = {
      balance: await balanceOf(outsiderEmployeeId, 'Annual'),
      days: await withTenant(prisma, COMPANY_A, (tx) =>
        tx.attendanceRecord.findMany({
          where: { leaveRequestId: created.id },
          orderBy: { date: 'asc' },
        }),
      ),
      inbox: (await inboxRow(created.id))?.status,
    };
    expect(before.days).toHaveLength(2);
    sink.events.length = 0;

    async function expectUnchanged(): Promise<void> {
      expect((await leave(created.id)).status).toBe('approved');
      expect(await balanceOf(outsiderEmployeeId, 'Annual')).toEqual(before.balance);
      const days = await withTenant(prisma, COMPANY_A, (tx) =>
        tx.attendanceRecord.findMany({
          where: { id: { in: before.days.map((day) => day.id) } },
          orderBy: { date: 'asc' },
        }),
      );
      expect(days).toEqual(before.days);
      expect((await inboxRow(created.id))?.status).toBe(before.inbox);
      expect(await auditsFor('leave_request', created.id, 'LEAVE_CANCELLED')).toEqual([]);
      for (const day of before.days) {
        expect(
          await auditsFor('attendance_record', day.id, 'ATTENDANCE_ADJUSTED_BY_ADMIN'),
        ).toEqual([]);
      }
      expect(sink.events).toEqual([]);
      expect(retryQueue.entries).toEqual([]);
    }

    // The reconciliation of the second day fails, after the balance moved
    // and the first day was reconciled.
    await withForcedFailure(
      'attendance_records',
      `TG_OP = 'UPDATE' AND OLD.leave_request_id = '${created.id}'::uuid AND NEW.date = DATE '2026-04-06'`,
      async () => {
        expect(
          (await act(ADMIN_A, created.id, 'cancel', { reason: 'Forced failure' })).status,
        ).toBe(500);
      },
    );
    await expectUnchanged();

    // The request's own status change fails, after everything else.
    await withForcedFailure(
      'leave_requests',
      `TG_OP = 'UPDATE' AND NEW.id = '${created.id}'::uuid AND NEW.status = 'cancelled'`,
      async () => {
        expect(
          (await act(ADMIN_A, created.id, 'cancel', { reason: 'Forced failure' })).status,
        ).toBe(500);
      },
    );
    await expectUnchanged();

    expect((await act(ADMIN_A, created.id, 'cancel', { reason: 'Now it works' })).status).toBe(200);
    expect(await auditsFor('leave_request', created.id, 'LEAVE_CANCELLED')).toHaveLength(1);
  });

  it('a successful approval is committed before its audit is dispatched, and its event after that', async () => {
    const created = await submitted(OUTSIDER, {
      type: 'Annual',
      start: '2026-04-19',
      end: '2026-04-19',
    });
    const dispatcher = app.get(AuditDispatcher);
    const original = dispatcher.dispatch.bind(dispatcher);
    const seen: { status: string | undefined; audits: number; events: number }[] = [];
    const spy = vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (entries, at) => {
      // Read from outside the business transaction: only committed state is visible.
      const row = await withTenant(prisma, COMPANY_A, (tx) =>
        tx.leaveRequest.findUnique({ where: { id: created.id }, select: { status: true } }),
      );
      seen.push({
        status: row?.status,
        audits: (await auditsFor('leave_request', created.id, 'LEAVE_APPROVED')).length,
        events: sink.events.length,
      });
      await original(entries, at);
    });
    sink.events.length = 0;
    try {
      expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    // Already committed, no audit written yet, no event yet.
    expect(seen).toEqual([{ status: 'approved', audits: 0, events: 0 }]);
    expect(await auditsFor('leave_request', created.id, 'LEAVE_APPROVED')).toHaveLength(1);
    expect(sink.events.map((event) => event.type)).toEqual(['leave_approved']);
  });

  it('a failed audit write never undoes the committed leave action; it is retried, then lands once', async () => {
    const created = await submitted(OUTSIDER, {
      type: 'Annual',
      start: '2026-04-26',
      end: '2026-04-26',
    });
    const usedBefore = (await balanceOf(outsiderEmployeeId, 'Annual')).used_days;
    sink.events.length = 0;
    await withForcedFailure(
      'audit_logs',
      `NEW.entity_id = '${created.id}'::uuid AND NEW.action = 'leave.approved'`,
      async () => {
        expect((await act(ADMIN_A, created.id, 'approve')).status).toBe(200);
      },
    );
    // The business action stands.
    expect((await leave(created.id)).status).toBe('approved');
    expect((await inboxRow(created.id))?.status).toBe('approved');
    expect(await leaveDays(created.id)).toHaveLength(1);
    expect(Number((await balanceOf(outsiderEmployeeId, 'Annual')).used_days)).toBe(
      Number(usedBefore) + 1,
    );
    expect(sink.events.map((event) => event.type)).toEqual(['leave_approved']);
    // The audit is not lost: it is on the retry queue, not yet written.
    expect(await auditsFor('leave_request', created.id, 'LEAVE_APPROVED')).toEqual([]);
    expect(retryQueue.entries).toHaveLength(1);
    const queued = retryQueue.entries[0] as QueuedAuditEntry;
    expect(queued).toMatchObject({ action: 'LEAVE_APPROVED', entityId: created.id });

    // The retry worker's write, run twice: it lands exactly once.
    const dispatcher = app.get(AuditDispatcher);
    await dispatcher.write(queued);
    await dispatcher.write(queued);
    const written = await auditsFor('leave_request', created.id, 'LEAVE_APPROVED');
    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe(queued.id);
  });

  it('when even the retry queue is unavailable, the entry goes to the error-log fallback', async () => {
    const created = await submitted(OUTSIDER, {
      type: 'Annual',
      start: '2026-05-03',
      end: '2026-05-03',
    });
    retryQueue.failing = true;
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await withForcedFailure(
        'audit_logs',
        `NEW.entity_id = '${created.id}'::uuid AND NEW.action = 'leave.rejected'`,
        async () => {
          expect(
            (await act(ADMIN_A, created.id, 'reject', { review_note: 'Not now' })).status,
          ).toBe(200);
        },
      );
      expect((await leave(created.id)).status).toBe('rejected');
      const fallback = errors.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('AUDIT_FALLBACK'));
      expect(fallback).toHaveLength(1);
      expect(fallback[0]).toContain(created.id);
      expect(fallback[0]).toContain('LEAVE_REJECTED');
    } finally {
      errors.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The Requests Centre — OD-09, completed for leave
// ---------------------------------------------------------------------------

describe('the Requests Centre delegates every leave decision to leave', () => {
  async function inboxIdFor(leaveId: string): Promise<string> {
    const row = await inboxRow(leaveId);
    if (row === null) throw new Error('no inbox row');
    return row.id;
  }

  it('shows leave context, and approving in the centre runs the leave approval', async () => {
    const created = await submitted(WORKER2, {
      type: 'Annual',
      start: '2026-06-21',
      end: '2026-06-22',
    });
    const id = await inboxIdFor(created.id);
    const centre = await (await api(MANAGER))
      .get('/requests')
      .query({ category: 'leave', status: 'pending' });
    const row = (
      centre.body.data as { id: string; leave: Leave | null; abilities: { can_review: boolean } }[]
    ).find((r) => r.id === id);
    expect(row?.leave).toMatchObject({ id: created.id, days_count: '2.00', status: 'pending' });
    expect(row?.leave?.balances[0]).toMatchObject({ year: 2026, pending_days: '2.00' });
    expect(row?.abilities.can_review).toBe(true);
    const reviewable = await (await api(MANAGER))
      .get('/requests')
      .query({ status: 'pending', reviewable: 'true' });
    expect((reviewable.body.data as { id: string }[]).some((r) => r.id === id)).toBe(true);
    // The dashboard KPI counts the same population, leave included.
    const count = await (await api(MANAGER)).get('/requests/pending-count');
    expect(count.body.data).toEqual({ count: reviewable.body.meta.total, basis: 'review' });

    const approved = await (await api(MANAGER))
      .post(`/requests/${id}/approve`)
      .send({ admin_response: 'OK' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: 'approved',
      leave: { status: 'approved', review_note: 'OK' },
    });
    expect(await leaveDays(created.id)).toHaveLength(2);
    expect(await auditsFor('leave_request', created.id, 'LEAVE_APPROVED')).toHaveLength(1);
    expect(await auditsFor('request', id, 'REQUEST_APPROVED')).toEqual([]);
  });

  it('rejecting in the centre needs a reason; cancelling in the centre releases the hold', async () => {
    const rejected = await submitted(WORKER2, {
      type: 'Annual',
      start: '2026-06-28',
      end: '2026-06-29',
    });
    const rejectedId = await inboxIdFor(rejected.id);
    expect(
      (await (await api(MANAGER)).post(`/requests/${rejectedId}/reject`).send({})).status,
    ).toBe(422);
    expect(
      (
        await (await api(MANAGER))
          .post(`/requests/${rejectedId}/reject`)
          .send({ admin_response: 'No' })
      ).status,
    ).toBe(200);
    expect((await leave(rejected.id)).status).toBe('rejected');

    const cancelled = await submitted(WORKER2, {
      type: 'Annual',
      start: '2026-07-05',
      end: '2026-07-06',
    });
    const pendingBefore = (await balanceOf(worker2EmployeeId, 'Annual')).pending_days;
    expect(pendingBefore).toBe('2.00');
    expect(
      (
        await (await api(WORKER2))
          .post(`/requests/${await inboxIdFor(cancelled.id)}/cancel`)
          .send({})
      ).status,
    ).toBe(200);
    expect((await leave(cancelled.id)).status).toBe('cancelled');
    expect((await balanceOf(worker2EmployeeId, 'Annual')).pending_days).toBe('0.00');
  });

  it('a bare leave request through /requests is still refused (no generic leave)', async () => {
    const bare = await (await api(WORKER))
      .post('/requests')
      .send({ category: 'leave', subject: 'x', description: 'y' });
    expect(bare.body.error.code).toBe('REQUEST_CATEGORY_SPECIALISED');
  });
});

// ---------------------------------------------------------------------------
// Balances — /leave-balances, rule 14
// ---------------------------------------------------------------------------

describe('balances — scope and audited adjustment', () => {
  it('each person sees their own; a manager their team; another company nothing', async () => {
    const mine = (await (await api(WORKER2)).get('/leave-balances/me')).body.data as Balance[];
    expect(mine.map((b) => b.leave_type.name_en)).toEqual(
      expect.arrayContaining(['Annual', 'Sick', 'Emergency', 'Other', 'Flexible']),
    );
    expect(mine.some((b) => b.leave_type.id === typeOf('Unpaid'))).toBe(false);
    const team = await (await api(MANAGER))
      .get('/leave-balances')
      .query({ employee_id: workerEmployeeId });
    expect((team.body.data as Balance[]).length).toBeGreaterThan(0);
    const outsider = await (await api(MANAGER))
      .get('/leave-balances')
      .query({ employee_id: outsiderEmployeeId });
    expect(outsider.body.data).toEqual([]);
    const colleague = await (await api(WORKER2))
      .get('/leave-balances')
      .query({ employee_id: workerEmployeeId });
    expect(colleague.body.data).toEqual([]);
    expect((await (await api(ADMIN_B)).get('/leave-balances')).body.data).toEqual([]);
    const otherCompany = (await (await api(WORKER_B)).get('/leave-balances/me')).body
      .data as Balance[];
    expect(otherCompany.every((b) => b.leave_type.id !== typeOf('Annual'))).toBe(true);
  });

  it('an ADMIN adjusts the entitlement with a reason, audited old and new; history is protected', async () => {
    const annual = await balanceOf(workerEmployeeId, 'Annual');
    expect(
      (
        await (await api(MANAGER))
          .patch(`/leave-balances/${annual.id}`)
          .send({ total_days: '20', reason: 'x' })
      ).status,
    ).toBe(403);
    const admin = await api(ADMIN_A);
    expect(
      (await admin.patch(`/leave-balances/${annual.id}`).send({ total_days: '20' })).status,
    ).toBe(422);
    expect(
      (await admin.patch(`/leave-balances/${annual.id}`).send({ used_days: '0', reason: 'x' }))
        .status,
    ).toBe(422);
    const below = await admin
      .patch(`/leave-balances/${annual.id}`)
      .send({ total_days: '1', reason: 'Oops' });
    expect(below.body.error.fields.total_days).toEqual(['below_committed']);
    const adjusted = await admin
      .patch(`/leave-balances/${annual.id}`)
      .send({ total_days: '20.5', reason: 'Long-service bonus' });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.data).toMatchObject({ total_days: '20.50', used_days: annual.used_days });
    const audits = await auditsFor('leave_balance', annual.id, 'LEAVE_BALANCE_ADJUSTED');
    expect(audits.at(-1)?.oldValues).toEqual({ total_days: annual.total_days });
    expect(audits.at(-1)?.newValues).toEqual({ total_days: '20.50', reason: 'Long-service bonus' });
    const foreign = await (await api(ADMIN_B))
      .patch(`/leave-balances/${annual.id}`)
      .send({ total_days: '1', reason: 'x' });
    expect(foreign.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Holiday declared inside approved leave — DOCUMENT 16 edge case
// ---------------------------------------------------------------------------

describe('a holiday declared inside approved leave', () => {
  it('is surfaced to the ADMIN and never silently recalculated', async () => {
    const approved = (
      (
        await (await api(ADMIN_A))
          .get('/leave-requests')
          .query({ employee_id: workerEmployeeId, status: 'approved' })
      ).body.data as Leave[]
    ).find((l) => l.start_date === '2026-03-15') as Leave;
    const holiday = await (await api(ADMIN_A))
      .post('/holidays')
      .send({ date: '2026-03-16', name_ar: 'عطلة', name_en: 'Holiday' });
    expect(holiday.status).toBe(201);
    expect(holiday.body.data.affected_leave_requests).toEqual([
      expect.objectContaining({
        id: approved.id,
        employee_id: workerEmployeeId,
        start_date: '2026-03-15',
      }),
    ]);
    const after = await leave(approved.id);
    expect(after.holidays_inside).toEqual(['2026-03-16']);
    expect(after.days_count).toBe('3.00');
    expect(await leaveDays(approved.id)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Carry-over — rule 13
// ---------------------------------------------------------------------------

describe('carry-over into the next year', () => {
  it('none, full and capped behave as documented; forfeiture is audited; a rerun changes nothing', async () => {
    const admin = await api(ADMIN_A);
    expect(
      (
        await admin
          .patch(`/leave-types/${typeOf('Annual')}`)
          .send({ carry_over_policy: 'capped', carry_over_cap: '5' })
      ).status,
    ).toBe(200);

    const annual2026 = await balanceOf(workerEmployeeId, 'Annual', 2026);
    const flexible2026 = await balanceOf(worker2EmployeeId, 'Flexible', 2026);
    const emergency2026 = await balanceOf(worker2EmployeeId, 'Emergency', 2026);
    const unusedAnnual = Decimal.parse(annual2026.remaining_days, 2);
    const cap = Decimal.parse('5', 2);
    expect(unusedAnnual.compare(cap)).toBe(1);

    const service = app.get(LeaveCarryOverService);
    const newYear = new Date(Date.UTC(2027, 0, 1, 8, 0, 0));
    const first = await service.runForCompany(COMPANY_A, newYear);
    expect(first.year).toBe(2027);
    expect(first.applied).toBeGreaterThan(0);

    const annual2027 = await balanceOf(workerEmployeeId, 'Annual', 2027);
    expect(annual2027.carried_over_days).toBe('5.00');
    const forfeiture = await auditsFor('leave_balance', annual2027.id, 'LEAVE_BALANCE_ADJUSTED');
    expect(forfeiture.at(-1)?.newValues).toMatchObject({
      carried_over_days: '5.00',
      forfeited_days: unusedAnnual.subtract(cap).toString(),
      from_year: 2026,
      reason: 'carry_over',
    });
    // Full: everything unused carries.
    expect((await balanceOf(worker2EmployeeId, 'Flexible', 2027)).carried_over_days).toBe(
      flexible2026.remaining_days,
    );
    // None: nothing carries.
    expect((await balanceOf(worker2EmployeeId, 'Emergency', 2027)).carried_over_days).toBe('0.00');
    expect(emergency2026.remaining_days).not.toBe('0.00');

    const rerun = await service.runForCompany(COMPANY_A, newYear);
    expect(rerun.applied).toBe(0);
    expect((await balanceOf(workerEmployeeId, 'Annual', 2027)).carried_over_days).toBe('5.00');
    expect(await auditsFor('leave_balance', annual2027.id, 'LEAVE_BALANCE_ADJUSTED')).toHaveLength(
      forfeiture.length,
    );

    // Company B is untouched by A's run.
    const b = await (await api(WORKER_B)).get('/leave-balances/me').query({ year: '2027' });
    expect((b.body.data as Balance[]).every((row) => row.carried_over_days === '0.00')).toBe(true);
  });
});
