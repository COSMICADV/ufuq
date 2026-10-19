/**
 * Phase 15 — notifications, end to end (DOCUMENT 19, DOCUMENT 25 Phase 15
 * exit: "every event in DOCUMENT 19 produces a notification for the correct
 * recipients and no one else").
 *
 * The real API on PGlite, under the restricted `ufuq_app` role and RLS, with
 * every migration. Each DOCUMENT 19 event is triggered by its **real source
 * action** — a leave submitted through `/leave-requests`, a stock movement
 * through `/stock-movements`, the nightly attendance close, the hourly task
 * scan — never by inserting a notification. For each, the recipients are
 * read across **every** company (as the database owner, past RLS) and must
 * be exactly the expected users: that is "no one else".
 *
 * People (company A, Cairo):
 *   - ADMIN_A — the seeded admin, no employee record;
 *   - ADMIN2  — a second admin with an employee record (multiple approvers,
 *     self-suppression);
 *   - MANAGER manages WORKER and WORKER2; MANAGER2 manages OUTSIDER.
 * Company B (Tokyo): ADMIN_B and WORKER_B, who must never be told about A.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { Notification, PrismaClient } from '@ufuq/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { AttendanceGenerationService } from '../src/attendance/attendance-generation.service.js';
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import type { StoredObjectInput } from '../src/attachments/object-storage.js';
import { AUDIT_RETRY_QUEUE } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import {
  NOTIFICATION_RETRY_QUEUE,
  NotificationPipeline,
} from '../src/notifications/notification-pipeline.js';
import type {
  NotificationRetryQueue,
  QueuedBatch,
} from '../src/notifications/notification-pipeline.js';
import {
  NotificationRetention,
  retentionCutoff,
} from '../src/notifications/notification-retention.js';
import { REPORT_EXPORT_LIMITS } from '../src/reports/report-exports.js';
import type { ReportExportLimits } from '../src/reports/report-exports.js';
import { TaskDeadlineScanner } from '../src/tasks/task-jobs.js';

import { allMigrationsSql } from './all-migrations.js';
import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';

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

class CapturingAuditQueue implements AuditRetryQueue {
  readonly entries: QueuedAuditEntry[] = [];
  enqueue(entry: QueuedAuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** The notification retry queue, captured so a test can run the retry itself. */
class CapturingNotificationQueue implements NotificationRetryQueue {
  readonly batches: QueuedBatch[] = [];
  enqueue(batch: QueuedBatch): Promise<void> {
    this.batches.push(batch);
    return Promise.resolve();
  }
}
const notificationQueue = new CapturingNotificationQueue();

class SwitchableStorage extends InMemoryObjectStorage {
  failing = false;
  override put(input: StoredObjectInput): Promise<void> {
    if (this.failing) return Promise.reject(new Error('storage unavailable'));
    return super.put(input);
  }
}
const storage = new SwitchableStorage();

/** Every export with rows goes to the background job, so its outcome is notified. */
const limits: ReportExportLimits = { syncMaxRows: 0, maxRows: 250_000, batchSize: 1_000 };

const COMPANY_A = generateId();
const COMPANY_B = generateId();
const CAIRO = 'Africa/Cairo';
const TOKYO = 'Asia/Tokyo';

interface Account {
  readonly email: string;
  readonly password: string;
}
const ADMIN_A: Account = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN2: Account = { email: 'admin2@a.test', password: 'admin2-password-2026' };
const MANAGER: Account = { email: 'manager@a.test', password: 'manager-password-2026' };
const MANAGER2: Account = { email: 'manager2@a.test', password: 'manager2-password-2026' };
const WORKER: Account = { email: 'worker@a.test', password: 'worker-password-2026' };
const WORKER2: Account = { email: 'worker2@a.test', password: 'worker2-password-2026' };
const OUTSIDER: Account = { email: 'outsider@a.test', password: 'outsider-password-2026' };
const TEMP: Account = { email: 'temp@a.test', password: 'temp-password-2026' };
const ADMIN_B: Account = { email: 'admin@b.test', password: 'admin-b-password-2026' };
const WORKER_B: Account = { email: 'worker@b.test', password: 'worker-b-password-2026' };

/** Sunday 10 May 2026, 11:00 in Cairo. */
const NOW = new Date(Date.UTC(2026, 4, 10, 8, 0, 0));
const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

const emp: Record<string, string> = {};
const uid: Record<string, string> = {};
let unpaidLeaveType = '';
let warehouseId = '';

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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

const tokens = new Map<string, string>();

function as(token: string, locale = 'en') {
  const auth = (r: request.Test) =>
    r.set('Authorization', `Bearer ${token}`).set('Accept-Language', locale);
  return {
    get: (path: string) => auth(request(server()).get(`/${API_PREFIX}${path}`)),
    post: (path: string) => auth(request(server()).post(`/${API_PREFIX}${path}`)),
    patch: (path: string) => auth(request(server()).patch(`/${API_PREFIX}${path}`)),
    delete: (path: string) => auth(request(server()).delete(`/${API_PREFIX}${path}`)),
  };
}

async function api(account: Account, locale = 'en') {
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
  return as(token, locale);
}

async function asOwner<T>(run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('RESET ROLE');
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
  }
}

/** Every notification in every company — the owner bypasses RLS. */
async function everyNotification(): Promise<Notification[]> {
  return asOwner(() =>
    prisma.notification.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  );
}

async function ofType(type: string): Promise<Notification[]> {
  return (await everyNotification()).filter((row) => row.type === type);
}

function usersOf(rows: readonly Notification[]): string[] {
  return [...new Set(rows.map((row) => row.userId))].sort();
}

function ids(...names: string[]): string[] {
  return names.map((name) => uid[name] as string).sort();
}

/**
 * DOCUMENT 25's exit check for one type: exactly these users received it, in
 * any company; each is a stored, well-formed notification in both languages.
 */
async function expectExactly(
  type: string,
  recipients: readonly string[],
  expected: { relatedType: string; relatedId?: string; priority?: string; audience?: string },
): Promise<Notification[]> {
  const rows = await ofType(type);
  expect(usersOf(rows), `${type} recipients`).toEqual([...recipients].sort());
  for (const row of rows) {
    expect(row.relatedType).toBe(expected.relatedType);
    if (expected.relatedId !== undefined) expect(row.relatedId).toBe(expected.relatedId);
    if (expected.priority !== undefined) expect(row.priority).toBe(expected.priority);
    if (expected.audience !== undefined) expect(row.audience).toBe(expected.audience);
    expect(row.channel).toBe('in_app');
    for (const text of [row.titleAr, row.titleEn, row.bodyAr, row.bodyEn]) {
      expect(text.length).toBeGreaterThan(0);
    }
    // Both languages are stored, and they are different languages.
    expect(row.titleAr).toMatch(/[؀-ۿ]/);
    expect(row.titleEn).not.toMatch(/[؀-ۿ]/);
  }
  return rows;
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

async function userIdOf(companyId: string, email: string): Promise<string> {
  return (
    await withTenant(prisma, companyId, (tx) =>
      tx.user.findFirstOrThrow({ where: { email }, select: { id: true } }),
    )
  ).id;
}

async function withTrigger(
  table: string,
  when: 'INSERT' | 'UPDATE',
  run: () => Promise<void>,
): Promise<void> {
  await asOwner(async () => {
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_force_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced failure'; END $$`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER test_force_failure BEFORE ${when} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_force_failure()`,
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

async function feed(account: Account, query = 'per_page=50', locale = 'en') {
  const response = await (await api(account, locale)).get(`/notifications?${query}`);
  expect(response.status).toBe(200);
  return response.body as {
    data: {
      id: string;
      type: string;
      priority: string;
      audience: string;
      title: { ar: string; en: string };
      body: { ar: string; en: string };
      related: {
        type: string;
        id: string | null;
        available: boolean;
        meta: Record<string, string> | null;
      };
      group_count: number;
      is_summary: boolean;
      read_at: string | null;
      handled_at: string | null;
      created_at: string;
    }[];
    meta: { page: number; per_page: number; total: number; total_pages: number };
  };
}

async function unread(account: Account): Promise<number> {
  const response = await (await api(account)).get('/notifications/unread-count');
  expect(response.status).toBe(200);
  return response.body.data.count as number;
}

async function requestRowFor(relatedType: string, relatedId: string): Promise<string> {
  return (
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.request.findFirstOrThrow({ where: { relatedType, relatedId }, select: { id: true } }),
    )
  ).id;
}

let leaveDay = 0;
/** A fresh pair of future working days for each leave request (no overlaps). */
function nextLeaveDates(): { start_date: string; end_date: string } {
  const start = new Date(Date.UTC(2026, 5, 7 + leaveDay * 7)); // Sundays from 7 June
  leaveDay += 1;
  const end = new Date(start.getTime() + 86_400_000);
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) };
}

async function submitLeave(account: Account): Promise<string> {
  const response = await (await api(account)).post('/leave-requests').send({
    leave_type_id: unpaidLeaveType,
    ...nextLeaveDates(),
    reason: 'Family matters',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function createTask(
  account: Account,
  assignee: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await (await api(account)).post('/tasks').send({
    title: 'Prepare the quarterly pitch',
    assignee_employee_id: assignee,
    priority: 'high',
    ...body,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

let idempotency = 0;
async function move(productId: string, type: string, quantity: string, unitCost?: string) {
  idempotency += 1;
  const response = await (
    await api(ADMIN_A)
  )
    .post('/stock-movements')
    .set('Idempotency-Key', `notify-${String(idempotency)}`)
    .send({
      product_id: productId,
      warehouse_id: warehouseId,
      type,
      quantity,
      ...(unitCost === undefined ? {} : { unit_cost: unitCost }),
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** Soft-deletes every task, so a deadline scan sees only the test's own. */
async function retireAllTasks(): Promise<void> {
  await asOwner(() =>
    prisma.$executeRawUnsafe('UPDATE "tasks" SET "deleted_at" = now() WHERE "deleted_at" IS NULL'),
  );
}

async function clearNotifications(): Promise<void> {
  await asOwner(() => prisma.$executeRawUnsafe('DELETE FROM "notifications"'));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  for (const [companyId, slug, zone, admin] of [
    [COMPANY_A, 'company-a', CAIRO, ADMIN_A],
    [COMPANY_B, 'company-b', TOKYO, ADMIN_B],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: { id: companyId, name: `Ufuq ${slug}`, slug, timezone: zone },
      });
      await tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: admin.email,
          passwordHash,
          roleId: roleIdByKey.get('admin') as string,
          status: 'active',
        },
      });
    });
  }
}

/** Present on every working day of March 2026, for payroll. */
async function seedMarch(employeeId: string): Promise<void> {
  const rows = Array.from({ length: 31 }, (_, i) => {
    const date = `2026-03-${String(i + 1).padStart(2, '0')}`;
    const weekend = new Date(`${date}T00:00:00.000Z`).getUTCDay() >= 5;
    return {
      id: generateId(),
      companyId: COMPANY_A,
      employeeId,
      date: new Date(`${date}T00:00:00.000Z`),
      status: weekend ? ('weekend' as const) : ('present' as const),
      source: weekend ? ('system' as const) : ('self' as const),
      workMode: weekend ? null : ('office' as const),
      checkInAt: weekend ? null : new Date(`${date}T07:00:00.000Z`),
      checkOutAt: weekend ? null : new Date(`${date}T15:00:00.000Z`),
      workingMinutes: weekend ? null : 420,
      lateMinutes: weekend ? null : 0,
      overtimeMinutes: weekend ? null : 0,
    };
  });
  await withTenant(prisma, COMPANY_A, (tx) => tx.attendanceRecord.createMany({ data: rows }));
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
    .overrideProvider(AUDIT_RETRY_QUEUE)
    .useValue(new CapturingAuditQueue())
    .overrideProvider(NOTIFICATION_RETRY_QUEUE)
    .useValue(notificationQueue)
    .overrideProvider(REPORT_EXPORT_LIMITS)
    .useValue(limits)
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

  // ---- Company A ---------------------------------------------------------------
  const admin = await api(ADMIN_A);
  const schedule = (
    await admin.post('/work-schedules').send({
      name: 'Standard week',
      timezone: CAIRO,
      grace_period_minutes: 15,
      break_minutes: 60,
      half_day_threshold_hours: '4.00',
      overtime_policy: 'paid',
      is_default: true,
      days: week(),
    })
  ).body.data.id as string;
  const sales = (await admin.post('/departments').send({ name_ar: 'المبيعات', name_en: 'Sales' }))
    .body.data.id as string;

  const person = (first: string, last: string, account: Account, code: string, extra = {}) => ({
    first_name: first,
    last_name: last,
    email: account.email,
    employee_code: code,
    department_id: sales,
    work_schedule_id: schedule,
    ...extra,
  });
  emp['admin2'] = await createEmployee(
    ADMIN_A,
    person('Hala', 'Mansour', ADMIN2, 'ADM-2', { role_key: 'admin' }),
  );
  emp['manager'] = await createEmployee(
    ADMIN_A,
    person('Mona', 'Saleh', MANAGER, 'MGR-1', { role_key: 'manager' }),
  );
  emp['manager2'] = await createEmployee(
    ADMIN_A,
    person('Tarek', 'Fouad', MANAGER2, 'MGR-2', { role_key: 'manager' }),
  );
  emp['worker'] = await createEmployee(
    ADMIN_A,
    person('Omar', 'Fathy', WORKER, 'EMP-1', { role_key: 'employee', manager_id: emp['manager'] }),
  );
  emp['worker2'] = await createEmployee(
    ADMIN_A,
    person('Sara', 'Adel', WORKER2, 'EMP-2', { role_key: 'employee', manager_id: emp['manager'] }),
  );
  emp['outsider'] = await createEmployee(
    ADMIN_A,
    person('Karim', 'Nabil', OUTSIDER, 'EMP-3', {
      role_key: 'employee',
      manager_id: emp['manager2'],
    }),
  );
  for (const account of [ADMIN2, MANAGER, MANAGER2, WORKER, WORKER2, OUTSIDER]) {
    await activate(account);
  }
  for (const [name, account] of [
    ['adminA', ADMIN_A],
    ['admin2', ADMIN2],
    ['manager', MANAGER],
    ['manager2', MANAGER2],
    ['worker', WORKER],
    ['worker2', WORKER2],
    ['outsider', OUTSIDER],
  ] as const) {
    uid[name] = await userIdOf(COMPANY_A, account.email);
  }

  const types = (await admin.get('/leave-types')).body.data as { id: string; name_en: string }[];
  unpaidLeaveType = types.find((t) => t.name_en === 'Unpaid')?.id as string;
  warehouseId = (
    await admin
      .post('/warehouses')
      .send({ name_ar: 'المخزن الرئيسي', name_en: 'Main store', type: 'main' })
  ).body.data.id as string;

  // ---- Company B ---------------------------------------------------------------
  const adminB = await api(ADMIN_B);
  const scheduleB = (
    await adminB.post('/work-schedules').send({
      name: 'Week',
      timezone: TOKYO,
      grace_period_minutes: 15,
      break_minutes: 60,
      half_day_threshold_hours: '4.00',
      overtime_policy: 'paid',
      is_default: true,
      days: week(),
    })
  ).body.data.id as string;
  emp['workerB'] = await createEmployee(ADMIN_B, {
    first_name: 'Yui',
    last_name: 'Sato',
    email: WORKER_B.email,
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB,
  });
  await activate(WORKER_B);
  uid['adminB'] = await userIdOf(COMPANY_B, ADMIN_B.email);
  uid['workerB'] = await userIdOf(COMPANY_B, WORKER_B.email);
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
  await socket?.stop();
  await pglite?.close();
});

beforeEach(async () => {
  vi.setSystemTime(NOW);
  redis.reset();
  notificationQueue.batches.length = 0;
  await clearNotifications();
});

// ---------------------------------------------------------------------------
// Leave — leave_request_submitted, leave_approved, leave_rejected
// ---------------------------------------------------------------------------

describe('leave: submitted → every eligible approver; decided → the employee', () => {
  it('leave_request_submitted reaches the admins and the employee’s own manager — no one else', async () => {
    const leaveId = await submitLeave(WORKER);
    const requestId = await requestRowFor('leave_request', leaveId);
    const rows = await expectExactly(
      'leave_request_submitted',
      ids('adminA', 'admin2', 'manager'),
      { relatedType: 'request', relatedId: requestId, priority: 'high', audience: 'admin' },
    );
    expect(rows[0]?.titleEn).toBe('New leave request');
    expect(rows[0]?.titleAr).toBe('طلب إجازة جديد');
    expect(rows[0]?.bodyEn).toContain('Omar Fathy requested Unpaid leave');
    expect(rows[0]?.bodyAr).toContain('طلب Omar Fathy إجازة');
    // MANAGER2 (another team), the submitter, colleagues and company B: nothing.
    expect(await everyNotification()).toHaveLength(3);
  });

  it('the first decision tells the employee and marks the other approvers’ notifications handled', async () => {
    const leaveId = await submitLeave(WORKER);
    const requestId = await requestRowFor('leave_request', leaveId);
    const approve = await (await api(MANAGER)).post(`/leave-requests/${leaveId}/approve`).send({});
    expect(approve.status).toBe(200);

    await expectExactly('leave_approved', ids('worker'), {
      relatedType: 'request',
      relatedId: requestId,
      priority: 'high',
      audience: 'employee',
    });
    const submitted = await ofType('leave_request_submitted');
    expect(submitted).toHaveLength(3);
    for (const row of submitted) {
      expect(row.handledAt, 'handled for every approver').not.toBeNull();
      expect(row.readAt, 'no longer pending, so no longer unread').not.toBeNull();
    }
    const adminFeed = await feed(ADMIN2);
    expect(adminFeed.data[0]?.handled_at).not.toBeNull();
    expect(await unread(ADMIN2)).toBe(0);
  });

  it('leave_rejected reaches the employee; the deciding admin is not told about their own action', async () => {
    const leaveId = await submitLeave(WORKER2);
    const reject = await (await api(ADMIN2))
      .post(`/leave-requests/${leaveId}/reject`)
      .send({ review_note: 'Peak season' });
    expect(reject.status).toBe(200);
    const rows = await expectExactly('leave_rejected', ids('worker2'), {
      relatedType: 'request',
      priority: 'high',
    });
    expect(rows[0]?.titleEn).toBe('Leave rejected');
    expect(rows[0]?.titleAr).toBe('تم رفض طلب إجازتك');
  });

  it('self-notification is suppressed: an admin’s own leave goes to the other admin only', async () => {
    await submitLeave(ADMIN2);
    await expectExactly('leave_request_submitted', ids('adminA'), { relatedType: 'request' });
  });

  it('a cancelled request tells nobody and leaves no approver thinking it is pending', async () => {
    const leaveId = await submitLeave(WORKER);
    const before = (await everyNotification()).length;
    expect(
      (await (await api(WORKER)).post(`/leave-requests/${leaveId}/cancel`).send({})).status,
    ).toBe(200);
    expect(await everyNotification()).toHaveLength(before);
    for (const row of await ofType('leave_request_submitted')) {
      expect(row.handledAt).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Attendance corrections
// ---------------------------------------------------------------------------

describe('attendance corrections', () => {
  async function correction(account: Account, date: string): Promise<string> {
    const response = await (await api(account)).post('/attendance-corrections').send({
      date,
      requested_check_in: `${date}T06:00:00.000Z`,
      requested_check_out: `${date}T14:00:00.000Z`,
      requested_work_mode: 'office',
      reason: 'I forgot to check in',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  }

  it('attendance_correction_submitted → approvers; correction_approved → the employee', async () => {
    const id = await correction(WORKER, '2026-05-06');
    const requestId = await requestRowFor('attendance_correction_request', id);
    const rows = await expectExactly(
      'attendance_correction_submitted',
      ids('adminA', 'admin2', 'manager'),
      { relatedType: 'request', relatedId: requestId, priority: 'high', audience: 'admin' },
    );
    expect(rows[0]?.bodyEn).toBe('Omar Fathy asked to correct attendance for 06 May 2026.');
    expect(rows[0]?.bodyAr).toBe('طلب Omar Fathy تصحيح الحضور ليوم 06 مايو 2026.');

    expect(
      (await (await api(ADMIN_A)).post(`/attendance-corrections/${id}/approve`).send({})).status,
    ).toBe(200);
    await expectExactly('correction_approved', ids('worker'), {
      relatedType: 'request',
      relatedId: requestId,
      audience: 'employee',
    });
    for (const row of await ofType('attendance_correction_submitted')) {
      expect(row.handledAt).not.toBeNull();
    }
  });

  it('correction_rejected → the employee only', async () => {
    const id = await correction(WORKER2, '2026-05-07');
    expect(
      (
        await (await api(MANAGER))
          .post(`/attendance-corrections/${id}/reject`)
          .send({ review_note: 'No evidence' })
      ).status,
    ).toBe(200);
    await expectExactly('correction_rejected', ids('worker2'), { relatedType: 'request' });
  });
});

// ---------------------------------------------------------------------------
// Requests Centre — native categories
// ---------------------------------------------------------------------------

describe('requests: request_submitted and request_reviewed', () => {
  async function submit(account: Account, subject: string): Promise<string> {
    const response = await (await api(account)).post('/requests').send({
      category: 'general',
      subject,
      description: 'Details',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  }

  it('a team member’s request → admins and their manager; approval → the requester', async () => {
    const id = await submit(WORKER, 'Parking permit');
    const rows = await expectExactly('request_submitted', ids('adminA', 'admin2', 'manager'), {
      relatedType: 'request',
      relatedId: id,
      priority: 'medium',
    });
    expect(rows[0]?.titleEn).toBe('New general request');
    expect(rows[0]?.titleAr).toBe('طلب جديد (عام)');
    expect((await (await api(MANAGER)).post(`/requests/${id}/approve`).send({})).status).toBe(200);
    const reviewed = await expectExactly('request_reviewed', ids('worker'), {
      relatedType: 'request',
      relatedId: id,
      priority: 'medium',
      audience: 'employee',
    });
    expect(reviewed[0]?.titleEn).toBe('Request approved');
    expect(reviewed[0]?.bodyAr).toBe('تمت الموافقة على طلبك «Parking permit».');
  });

  it('a manager is told only about their own team: OUTSIDER’s request reaches MANAGER2, never MANAGER', async () => {
    const id = await submit(OUTSIDER, 'Laptop');
    await expectExactly('request_submitted', ids('adminA', 'admin2', 'manager2'), {
      relatedType: 'request',
    });
    expect(
      (
        await (await api(MANAGER2))
          .post(`/requests/${id}/reject`)
          .send({ admin_response: 'No budget' })
      ).status,
    ).toBe(200);
    const rows = await expectExactly('request_reviewed', ids('outsider'), {
      relatedType: 'request',
    });
    expect(rows[0]?.titleEn).toBe('Request rejected');
  });

  it('a cancelled request is marked handled for every reviewer', async () => {
    const id = await submit(WORKER2, 'Desk');
    expect((await (await api(WORKER2)).post(`/requests/${id}/cancel`).send({})).status).toBe(200);
    const rows = await ofType('request_submitted');
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.handledAt !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tasks — task_assigned, task_updated, task_deadline_approaching, task_overdue
// ---------------------------------------------------------------------------

describe('tasks', () => {
  it('task_assigned → the assignee only; a reassignment → the new assignee only', async () => {
    const id = await createTask(ADMIN_A, emp['worker'] as string, { deadline: '2026-05-20' });
    const rows = await expectExactly('task_assigned', ids('worker'), {
      relatedType: 'task',
      relatedId: id,
      priority: 'high',
      audience: 'employee',
    });
    expect(rows[0]?.bodyEn).toBe('You have been assigned “Prepare the quarterly pitch”.');
    expect(rows[0]?.bodyAr).toBe('أُسندت إليك المهمة «Prepare the quarterly pitch».');

    await clearNotifications();
    expect(
      (
        await (await api(MANAGER))
          .patch(`/tasks/${id}`)
          .send({ assignee_employee_id: emp['worker2'] })
      ).status,
    ).toBe(200);
    await expectExactly('task_assigned', ids('worker2'), { relatedType: 'task', relatedId: id });
    expect(await ofType('task_updated')).toEqual([]);
  });

  it('assigning yourself a task tells nobody', async () => {
    await createTask(ADMIN2, emp['admin2'] as string);
    expect(await everyNotification()).toEqual([]);
  });

  it('task_updated → the assignee when someone else edits or sets its status; never for their own change', async () => {
    const id = await createTask(ADMIN_A, emp['worker'] as string);
    await clearNotifications();
    expect(
      (await (await api(ADMIN_A)).patch(`/tasks/${id}`).send({ title: 'Pitch v2' })).status,
    ).toBe(200);
    const rows = await expectExactly('task_updated', ids('worker'), {
      relatedType: 'task',
      relatedId: id,
      priority: 'low',
    });
    expect(rows[0]?.bodyEn).toBe('“Pitch v2” was updated.');

    await clearNotifications();
    expect(
      (await (await api(WORKER)).post(`/tasks/${id}/status`).send({ status: 'in_progress' }))
        .status,
    ).toBe(200);
    expect(await everyNotification(), 'the assignee’s own change').toEqual([]);

    expect(
      (
        await (await api(MANAGER))
          .post(`/tasks/${id}/status`)
          .send({ status: 'on_hold', reason: 'Waiting' })
      ).status,
    ).toBe(200);
    await expectExactly('task_updated', ids('worker'), { relatedType: 'task' });
  });

  it('task_deadline_approaching: the open tasks due today in the company’s zone, once, to the assignee', async () => {
    const scanner = app.get(TaskDeadlineScanner);
    await retireAllTasks();
    const due = await createTask(ADMIN_A, emp['worker'] as string, { deadline: '2026-05-10' });
    const done = await createTask(ADMIN_A, emp['worker'] as string, { deadline: '2026-05-10' });
    for (const status of ['in_progress', 'completed']) {
      expect(
        (await (await api(ADMIN_A)).post(`/tasks/${done}/status`).send({ status })).status,
      ).toBe(200);
    }
    await createTask(ADMIN_A, emp['worker'] as string, { deadline: '2026-05-11' });
    await clearNotifications();

    await scanner.runCompany(COMPANY_A, NOW);
    const rows = await expectExactly('task_deadline_approaching', ids('worker'), {
      relatedType: 'task',
      relatedId: due,
      priority: 'medium',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bodyEn).toBe('“Prepare the quarterly pitch” is due on 10 May 2026.');

    // The hourly scan sees it again: no duplicate.
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    await scanner.runCompany(COMPANY_A, new Date(NOW.getTime() + 3_600_000));
    expect(await ofType('task_deadline_approaching')).toHaveLength(1);

    // 22:30 UTC on the 10th is 01:30 on the 11th in Cairo: the task due on the
    // 11th is now approaching, by the company's calendar, not UTC's.
    const lateNight = new Date(Date.UTC(2026, 4, 10, 22, 30));
    vi.setSystemTime(lateNight);
    await scanner.runCompany(COMPANY_A, lateNight);
    const after = await ofType('task_deadline_approaching');
    expect(after).toHaveLength(2);
    expect(usersOf(after)).toEqual(ids('worker'));
  });

  it('task_overdue: once per task becoming overdue — not every scan, not every day — to the task’s supervisors', async () => {
    const scanner = app.get(TaskDeadlineScanner);
    await retireAllTasks();
    const id = await createTask(ADMIN_A, emp['worker'] as string, { deadline: '2026-05-07' });
    await clearNotifications();

    await scanner.runCompany(COMPANY_A, NOW);
    const rows = await expectExactly('task_overdue', ids('adminA', 'admin2', 'manager'), {
      relatedType: 'task',
      relatedId: id,
      priority: 'medium',
      audience: 'admin',
    });
    expect(rows[0]?.bodyEn).toBe(
      '“Prepare the quarterly pitch”, assigned to Omar Fathy, passed its deadline (07 May 2026).',
    );

    for (const offset of [1, 24, 48]) {
      const later = new Date(NOW.getTime() + offset * 3_600_000);
      vi.setSystemTime(later);
      await scanner.runCompany(COMPANY_A, later);
    }
    expect(await ofType('task_overdue'), 'still one per recipient').toHaveLength(3);

    // A moved deadline that is passed again is a new overdue moment.
    vi.setSystemTime(NOW);
    expect(
      (await (await api(ADMIN_A)).patch(`/tasks/${id}`).send({ deadline: '2026-05-08' })).status,
    ).toBe(200);
    await scanner.runCompany(COMPANY_A, NOW);
    expect(await ofType('task_overdue')).toHaveLength(6);

    // A completed task is never overdue.
    await clearNotifications();
    for (const status of ['in_progress', 'completed']) {
      expect((await (await api(WORKER)).post(`/tasks/${id}/status`).send({ status })).status).toBe(
        200,
      );
    }
    await (await api(ADMIN_A)).patch(`/tasks/${id}`).send({ deadline: '2026-05-06' });
    await clearNotifications();
    await scanner.runCompany(COMPANY_A, NOW);
    expect(await ofType('task_overdue')).toEqual([]);
  });

  it('a bulk scan that finds several overdue tasks gives each supervisor one summary', async () => {
    const scanner = app.get(TaskDeadlineScanner);
    await retireAllTasks();
    await createTask(ADMIN_A, emp['worker'] as string, { title: 'Alpha', deadline: '2026-05-04' });
    await createTask(ADMIN_A, emp['worker2'] as string, { title: 'Bravo', deadline: '2026-05-05' });
    await clearNotifications();
    await scanner.runCompany(COMPANY_A, NOW);
    const managerFeed = await feed(MANAGER);
    expect(managerFeed.data).toHaveLength(1);
    expect(managerFeed.data[0]).toMatchObject({
      type: 'task_overdue',
      is_summary: true,
      group_count: 2,
    });
    expect(managerFeed.data[0]?.title.en).toBe('Overdue tasks: 2');
    expect(managerFeed.data[0]?.title.ar).toBe('مهام متأخرة: 2');
    expect(managerFeed.data[0]?.related).toMatchObject({ type: 'task', id: null, available: true });
    expect(await unread(MANAGER)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Goals — goal_assigned, goal_milestone (both tables)
// ---------------------------------------------------------------------------

describe('goals', () => {
  async function createGoal(account: Account): Promise<string> {
    const response = await (await api(account)).post('/goals').send({
      employee_id: emp['worker'],
      type: 'sales',
      title: 'May sales',
      target_value: '100',
      unit: 'EGP',
      period_start: '2026-05-01',
      period_end: '2026-05-31',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.id as string;
  }

  async function progress(id: string, account: Account, value: string): Promise<void> {
    const response = await (await api(account)).post(`/goals/${id}/progress`).send({ value });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  it('goal_assigned → the owner only', async () => {
    const id = await createGoal(ADMIN_A);
    const rows = await expectExactly('goal_assigned', ids('worker'), {
      relatedType: 'goal',
      relatedId: id,
      priority: 'medium',
      audience: 'employee',
    });
    expect(rows[0]?.bodyEn).toBe('You have a new goal: “May sales”.');
  });

  it('goal_milestone → the owner, the creator and the owner’s manager; each threshold once; the actor never', async () => {
    const id = await createGoal(ADMIN_A);
    await clearNotifications();

    // ADMIN2 records 30: 25% crossed. ADMIN2 is neither creator nor manager.
    await progress(id, ADMIN2, '30');
    let rows = await expectExactly('goal_milestone', ids('worker', 'adminA', 'manager'), {
      relatedType: 'goal',
      relatedId: id,
      priority: 'low',
    });
    expect(rows.find((row) => row.userId === uid['worker'])?.audience).toBe('employee');
    expect(rows.find((row) => row.userId === uid['worker'])?.bodyEn).toBe(
      'Your goal “May sales” reached 25%.',
    );
    const managerRow = rows.find((row) => row.userId === uid['manager']);
    expect(managerRow?.audience).toBe('admin');
    expect(managerRow?.bodyEn).toBe('Omar Fathy’s goal “May sales” reached 25%.');
    expect(managerRow?.bodyAr).toBe('وصل هدف Omar Fathy «May sales» إلى 25%.');

    // The manager records 60: 50% crossed, and the manager is not told about it.
    await clearNotifications();
    await progress(id, MANAGER, '60');
    rows = await expectExactly('goal_milestone', ids('worker', 'adminA'), { relatedType: 'goal' });

    // 100: 75% and 100% — two notifications each, one per threshold.
    await clearNotifications();
    await progress(id, ADMIN2, '100');
    rows = await ofType('goal_milestone');
    expect(rows.filter((row) => row.userId === uid['worker'])).toHaveLength(2);

    // Down to 40 and back to 90: 50% and 75% were already told — never again.
    await clearNotifications();
    await progress(id, ADMIN2, '40');
    await progress(id, ADMIN2, '90');
    expect(await ofType('goal_milestone')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Inventory — low_stock, out_of_stock (once per crossing)
// ---------------------------------------------------------------------------

describe('inventory: once per crossing, again after recovery', () => {
  it('low_stock and out_of_stock reach the company-scope stock holders only, once per crossing', async () => {
    const product = await (await api(ADMIN_A)).post('/products').send({
      name_ar: 'قماش قطني',
      name_en: 'Cotton fabric',
      sku: 'NOTIFY-1',
      unit: 'piece',
      min_stock: '5',
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const productId = product.body.data.id as string;

    await move(productId, 'purchase', '10', '2.00');
    expect(await everyNotification()).toEqual([]);
    await move(productId, 'sale', '6'); // 4 ≤ 5: crossing
    const low = await expectExactly('low_stock', ids('adminA', 'admin2'), {
      relatedType: 'product',
      relatedId: productId,
      priority: 'high',
      audience: 'admin',
    });
    expect(low[0]?.bodyEn).toBe('Cotton fabric is at or below its minimum stock.');
    expect(low[0]?.bodyAr).toBe('وصل مخزون قماش قطني إلى الحد الأدنى أو أقل.');

    await move(productId, 'sale', '1'); // still low: no new notification
    expect(await ofType('low_stock')).toHaveLength(2);

    await move(productId, 'sale', '3'); // zero: out of stock
    await expectExactly('out_of_stock', ids('adminA', 'admin2'), {
      relatedType: 'product',
      relatedId: productId,
      priority: 'high',
    });

    // Recovery above the line, then a new crossing: told again.
    await move(productId, 'purchase', '10', '2.00');
    await move(productId, 'sale', '7');
    expect(await ofType('low_stock')).toHaveLength(4);
    // A manager has no stock grant: never told about stock.
    expect(usersOf(await ofType('low_stock'))).toEqual(ids('adminA', 'admin2'));
  });
});

// ---------------------------------------------------------------------------
// Payroll — payroll_ready, salary_finalized (no amounts)
// ---------------------------------------------------------------------------

describe('payroll', () => {
  it('payroll_ready → the other payroll admins; salary_finalized → every employee with a line; no figures anywhere', async () => {
    const admin = await api(ADMIN_A);
    expect(
      (
        await admin.patch('/salary-policies').send({
          name: 'Standard',
          daily_wage_basis: 'fixed_days',
          fixed_days_value: 30,
          unpaid_leave_deduction: 'daily_wage',
          absence_deduction: 'daily_wage',
          lateness_rule: { type: 'per_minute', multiplier: '1.00' },
          overtime_rate: '1.50',
          rounding: 'none',
        })
      ).status,
    ).toBe(200);
    for (const name of ['admin2', 'manager', 'manager2', 'worker', 'worker2', 'outsider']) {
      const set = await admin
        .post(`/employees/${emp[name] as string}/salary`)
        .send({ monthly_salary: '20500.00', effective_from: '2026-01-05' });
      expect(set.status, JSON.stringify(set.body)).toBe(201);
      await seedMarch(emp[name] as string);
    }
    await clearNotifications();

    const generated = await admin.post('/payroll/periods').send({ year: 2026, month: 3 });
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    const periodId = generated.body.data.id as string;
    // ADMIN_A generated it: told is ADMIN2. Managers have no payroll grant (OD-07).
    const ready = await expectExactly('payroll_ready', ids('admin2'), {
      relatedType: 'payroll_period',
      relatedId: periodId,
      priority: 'high',
      audience: 'admin',
    });
    expect(ready[0]?.bodyEn).toBe(
      'Payroll for March 2026 has been generated and is ready for review.',
    );

    for (const step of ['submit-review', 'approve']) {
      expect((await admin.post(`/payroll/periods/${periodId}/${step}`).send({})).status).toBe(200);
    }
    const finalized = await admin
      .post(`/payroll/periods/${periodId}/finalize`)
      .send({ confirm: '2026-03' });
    expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);

    const rows = await expectExactly(
      'salary_finalized',
      ids('admin2', 'manager', 'manager2', 'worker', 'worker2', 'outsider'),
      {
        relatedType: 'payroll_period',
        relatedId: periodId,
        priority: 'high',
        audience: 'employee',
      },
    );
    expect(rows[0]?.titleAr).toBe('تم اعتماد راتبك');
    expect(rows[0]?.bodyEn).toBe('Your salary for March 2026 has been finalized.');
    // DOCUMENT 19 rule 7: no amount, in any language, in any payroll notification.
    for (const row of [...rows, ...ready]) {
      const text = [row.titleAr, row.titleEn, row.bodyAr, row.bodyEn].join(' ');
      expect(text).not.toMatch(/20[,.]?500|EGP|ج\.م/);
      expect(text.replaceAll('2026', '')).not.toMatch(/\d{3,}/);
    }
  });
});

// ---------------------------------------------------------------------------
// Attendance — missing_checkout, employee_missing_checkout (the nightly close)
// ---------------------------------------------------------------------------

describe('attendance: the nightly close of a forgotten check-out', () => {
  it('missing_checkout → the employee; employee_missing_checkout → their supervisors, one summary each', async () => {
    const date = '2026-05-05';
    for (const name of ['worker', 'worker2']) {
      await withTenant(prisma, COMPANY_A, (tx) =>
        tx.attendanceRecord.create({
          data: {
            id: generateId(),
            companyId: COMPANY_A,
            employeeId: emp[name] as string,
            date: new Date(`${date}T00:00:00.000Z`),
            status: 'present',
            source: 'self',
            workMode: 'office',
            checkInAt: new Date(`${date}T06:00:00.000Z`),
            lateMinutes: 0,
          },
        }),
      );
    }
    const generation = app.get(AttendanceGenerationService);
    const result = await generation.generateRange(
      COMPANY_A,
      { year: 2026, month: 5, day: 5 },
      { year: 2026, month: 5, day: 5 },
      NOW,
    );
    expect(result.closed).toBe(2);

    const own = await expectExactly('missing_checkout', ids('worker', 'worker2'), {
      relatedType: 'attendance_record',
      priority: 'medium',
      audience: 'employee',
    });
    expect(own.find((row) => row.userId === uid['worker'])?.bodyEn).toContain(
      'You did not check out on 05 May 2026.',
    );
    // Two records, one night: each supervisor gets one summary (DOCUMENT 19 "Bulk operation").
    const supervisors = await ofType('employee_missing_checkout');
    expect(usersOf(supervisors)).toEqual(ids('adminA', 'admin2', 'manager'));
    const managerFeed = await feed(MANAGER);
    expect(managerFeed.data).toHaveLength(1);
    expect(managerFeed.data[0]).toMatchObject({
      type: 'employee_missing_checkout',
      is_summary: true,
      group_count: 2,
      priority: 'low',
    });
    // The employee's own item links to the day.
    const workerFeed = await feed(WORKER);
    expect(workerFeed.data[0]?.related).toMatchObject({
      type: 'attendance_record',
      available: true,
      meta: { date, employee_id: emp['worker'] },
    });

    // Re-running the night closes nothing more and tells nobody again.
    await generation.generateRange(
      COMPANY_A,
      { year: 2026, month: 5, day: 5 },
      { year: 2026, month: 5, day: 5 },
      NOW,
    );
    expect(await ofType('missing_checkout')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Employees — tasks_need_reassignment; inactive recipients
// ---------------------------------------------------------------------------

describe('deactivation', () => {
  it('tasks_need_reassignment → supervisors (not the deactivating admin); the deactivated user keeps history but cannot use it', async () => {
    const tempId = await createEmployee(ADMIN_A, {
      first_name: 'Laila',
      last_name: 'Hassan',
      email: TEMP.email,
      employee_code: 'TMP-1',
      role_key: 'employee',
      manager_id: emp['manager'],
      work_schedule_id: (
        await withTenant(prisma, COMPANY_A, (tx) =>
          tx.employee.findFirstOrThrow({
            where: { id: emp['worker'] as string },
            select: { workScheduleId: true },
          }),
        )
      ).workScheduleId,
    });
    await activate(TEMP);
    uid['temp'] = await userIdOf(COMPANY_A, TEMP.email);
    const taskId = await createTask(ADMIN_A, tempId);
    await createTask(ADMIN_A, tempId, { title: 'Second' });
    const tempFeed = await feed(TEMP);
    expect(tempFeed.data.length).toBeGreaterThan(0);
    await clearNotifications();
    // TEMP keeps one stored notification across the deactivation.
    await createTask(ADMIN_A, tempId, { title: 'Third' });
    expect(await ofType('task_assigned')).toHaveLength(1);

    const deactivated = await (await api(ADMIN2))
      .post(`/employees/${tempId}/deactivate`)
      .send({ reason: 'Contract ended' });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
    const rows = await expectExactly('tasks_need_reassignment', ids('adminA', 'manager'), {
      relatedType: 'employee',
      relatedId: tempId,
      priority: 'medium',
      audience: 'admin',
    });
    expect(rows[0]?.bodyEn).toBe('Laila Hassan was deactivated with open tasks: 3.');

    // Stored, never removed by the deactivation…
    expect(usersOf(await ofType('task_assigned'))).toEqual([uid['temp']]);
    // …but the deactivated user's session is gone: the centre is unreachable.
    expect((await (await api(TEMP)).get('/notifications')).status).toBe(401);
    // And nothing new is stored for an inactive recipient.
    await clearNotifications();
    await (await api(ADMIN_A)).patch(`/tasks/${taskId}`).send({ title: 'Renamed' });
    expect(await everyNotification()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reports — monthly_report_ready, export outcomes
// ---------------------------------------------------------------------------

describe('reports', () => {
  it('monthly_report_ready → the employee; an employee generating their own month is not told', async () => {
    const generated = await (await api(ADMIN_A))
      .post(`/reports/employee/${emp['worker'] as string}/monthly/2026/4/generate`)
      .send({});
    expect(generated.status, JSON.stringify(generated.body)).toBe(201);
    const rows = await expectExactly('monthly_report_ready', ids('worker'), {
      relatedType: 'monthly_report',
      relatedId: generated.body.data.id as string,
      priority: 'low',
      audience: 'employee',
    });
    expect(rows[0]?.bodyEn).toBe('Your monthly report for April 2026 is ready.');
    const workerFeed = await feed(WORKER);
    expect(workerFeed.data[0]?.related.meta).toMatchObject({ month: '2026-04' });

    await clearNotifications();
    const own = await (await api(WORKER2))
      .post(`/reports/employee/${emp['worker2'] as string}/monthly/2026/4/generate`)
      .send({});
    expect(own.status).toBe(201);
    expect(await everyNotification()).toEqual([]);
  });

  it('a background export’s completion and failure reach the requester only', async () => {
    const admin = await api(ADMIN_A);
    async function exportAndWait(): Promise<void> {
      const queued = await admin
        .post('/reports/attendance/export')
        .send({ format: 'csv', from: '2026-03-01', to: '2026-03-31' });
      expect(queued.status, JSON.stringify(queued.body)).toBe(202);
      const id = queued.body.data.id as string;
      for (let i = 0; i < 50; i += 1) {
        const status = (await admin.get(`/reports/exports/${id}`)).body.data.status as string;
        if (status === 'completed' || status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (let i = 0; i < 50 && (await everyNotification()).length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await exportAndWait();
    const done = await expectExactly('report_export_completed', ids('adminA'), {
      relatedType: 'report_export',
      priority: 'low',
    });
    expect(done[0]?.bodyEn).toBe('Your attendance report export is ready to download.');

    storage.failing = true;
    try {
      await exportAndWait();
    } finally {
      storage.failing = false;
    }
    await expectExactly('report_export_failed', ids('adminA'), {
      relatedType: 'report_export',
      priority: 'medium',
    });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('company B’s leave reaches only company B; no user of A is ever a recipient', async () => {
    const types = (await (await api(ADMIN_B)).get('/leave-types')).body.data as {
      id: string;
      name_en: string;
    }[];
    const leave = await (await api(WORKER_B)).post('/leave-requests').send({
      leave_type_id: types.find((t) => t.name_en === 'Unpaid')?.id,
      start_date: '2026-06-01',
      end_date: '2026-06-02',
      reason: 'Trip',
    });
    expect(leave.status, JSON.stringify(leave.body)).toBe(201);
    const rows = await expectExactly('leave_request_submitted', ids('adminB'), {
      relatedType: 'request',
    });
    expect(rows.every((row) => row.companyId === COMPANY_B)).toBe(true);

    // A's users see none of it, and cannot reach it by id: 404.
    expect((await feed(ADMIN_A)).data).toEqual([]);
    const foreign = rows[0]?.id as string;
    expect((await (await api(ADMIN_A)).post(`/notifications/${foreign}/read`)).status).toBe(404);
    expect(
      (await asOwner(() => prisma.notification.findUniqueOrThrow({ where: { id: foreign } })))
        .readAt,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The notification centre — own feed only, read, read-all, count, paging, locale
// ---------------------------------------------------------------------------

describe('the notification centre', () => {
  async function seedFeed(userId: string, count: number): Promise<string[]> {
    const created: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const id = generateId();
      created.push(id);
      await withTenant(prisma, COMPANY_A, (tx) =>
        tx.notification.create({
          data: {
            id,
            companyId: COMPANY_A,
            userId,
            type: 'task_updated',
            priority: 'low',
            audience: 'employee',
            titleAr: `تم تحديث مهمة ${String(i)}`,
            titleEn: `Task updated ${String(i)}`,
            bodyAr: 'تم تحديث المهمة.',
            bodyEn: 'The task was updated.',
            relatedType: 'task',
            relatedId: generateId(),
            createdAt: new Date(NOW.getTime() - (count - i) * 60_000),
          },
        }),
      );
    }
    return created;
  }

  it('lists only the caller’s notifications, newest first, paged and bounded', async () => {
    await seedFeed(uid['worker2'] as string, 25);
    await seedFeed(uid['worker'] as string, 2);
    const first = await feed(WORKER2, 'per_page=10');
    expect(first.meta).toMatchObject({ page: 1, per_page: 10, total: 25, total_pages: 3 });
    expect(first.data[0]?.title.en).toBe('Task updated 24');
    const third = await feed(WORKER2, 'per_page=10&page=3');
    expect(third.data).toHaveLength(5);
    expect(third.data[4]?.title.en).toBe('Task updated 0');
    const all = [
      ...first.data,
      ...(await feed(WORKER2, 'per_page=10&page=2')).data,
      ...third.data,
    ].map((item) => item.id);
    expect(new Set(all).size).toBe(25);
    // Bounded: more than 50 per page is refused.
    expect((await (await api(WORKER2)).get('/notifications?per_page=51')).status).toBe(422);
    // There is no parameter that names another user's feed.
    expect(
      (await (await api(ADMIN_A)).get(`/notifications?user_id=${uid['worker2'] as string}`)).status,
    ).toBe(422);
  });

  it('a deleted source renders as unavailable, not as a broken link', async () => {
    const id = await createTask(ADMIN_A, emp['worker'] as string);
    expect((await feed(WORKER)).data[0]?.related).toMatchObject({
      type: 'task',
      id,
      available: true,
    });
    expect((await (await api(ADMIN_A)).delete(`/tasks/${id}`)).status).toBe(204);
    expect((await feed(WORKER)).data[0]?.related).toMatchObject({
      type: 'task',
      id,
      available: false,
    });
  });

  it('read, read-all and the unread count act on the caller’s own notifications only', async () => {
    const mine = await seedFeed(uid['worker2'] as string, 3);
    const theirs = await seedFeed(uid['worker'] as string, 2);
    expect(await unread(WORKER2)).toBe(3);

    // Someone else's notification is 404, and stays unread.
    expect(
      (await (await api(WORKER2)).post(`/notifications/${theirs[0] as string}/read`)).status,
    ).toBe(404);
    expect(await unread(WORKER)).toBe(2);

    const read = await (await api(WORKER2)).post(`/notifications/${mine[0] as string}/read`);
    expect(read.status).toBe(200);
    expect(read.body.data.read_at).not.toBeNull();
    // Idempotent.
    expect(
      (await (await api(WORKER2)).post(`/notifications/${mine[0] as string}/read`)).status,
    ).toBe(200);
    expect(await unread(WORKER2)).toBe(2);
    expect((await feed(WORKER2, 'unread=true')).data).toHaveLength(2);

    const all = await (await api(WORKER2)).post('/notifications/read-all');
    expect(all.status).toBe(200);
    expect(all.body.data.updated).toBe(2);
    expect(await unread(WORKER2)).toBe(0);
    expect(await unread(WORKER)).toBe(2);
    expect((await (await api(WORKER2)).post(`/notifications/${generateId()}/read`)).status).toBe(
      404,
    );
    expect((await request(server()).get(`/${API_PREFIX}/notifications`)).status).toBe(401);
  });

  it('both languages are stored: switching language renders history in the new one', async () => {
    await createTask(ADMIN_A, emp['worker'] as string, { title: 'Inventory count' });
    const english = await feed(WORKER, 'per_page=50', 'en');
    const arabic = await feed(WORKER, 'per_page=50', 'ar');
    expect(arabic.data).toEqual(english.data);
    expect(english.data[0]?.title).toEqual({
      ar: 'مهمة جديدة مسندة إليك',
      en: 'New task assigned to you',
    });
    expect(english.data[0]?.body).toEqual({
      ar: 'أُسندت إليك المهمة «Inventory count».',
      en: 'You have been assigned “Inventory count”.',
    });
  });
});

// ---------------------------------------------------------------------------
// Grouping — DOCUMENT 19 rule 4
// ---------------------------------------------------------------------------

describe('grouping: more than three of a type within an hour become one summary', () => {
  it('three stay separate; the fourth and fifth collapse into one summary; after an hour a new one is separate', async () => {
    const submit = async (subject: string) =>
      (await api(WORKER))
        .post('/requests')
        .send({ category: 'general', subject, description: 'x' });

    for (const subject of ['One', 'Two', 'Three']) {
      expect((await submit(subject)).status).toBe(201);
      vi.setSystemTime(new Date(Date.now() + 60_000));
    }
    expect((await feed(ADMIN_A)).data).toHaveLength(3);
    expect(await unread(ADMIN_A)).toBe(3);

    expect((await submit('Four')).status).toBe(201);
    let items = (await feed(ADMIN_A)).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'request_submitted', is_summary: true, group_count: 4 });
    expect(items[0]?.title).toEqual({ ar: 'طلبات جديدة: 4', en: 'New requests: 4' });
    expect(items[0]?.related).toMatchObject({ type: 'request', id: null, available: true });
    expect(await unread(ADMIN_A)).toBe(1);

    vi.setSystemTime(new Date(Date.now() + 60_000));
    expect((await submit('Five')).status).toBe(201);
    items = (await feed(ADMIN_A)).data;
    expect(items).toHaveLength(1);
    expect(items[0]?.group_count).toBe(5);
    expect(items[0]?.title.en).toBe('New requests: 5');
    // Every approver has the same summary; the five rows are kept behind it.
    for (const account of [ADMIN2, MANAGER]) {
      expect((await feed(account)).data.map((item) => item.group_count)).toEqual([5]);
    }
    const adminRows = (await ofType('request_submitted')).filter(
      (row) => row.userId === uid['adminA'],
    );
    expect(adminRows).toHaveLength(6); // one summary + five absorbed rows

    // Reading the summary reads the rows it stands for.
    expect(
      (await (await api(ADMIN_A)).post(`/notifications/${items[0]?.id as string}/read`)).status,
    ).toBe(200);
    expect(
      (await ofType('request_submitted')).filter(
        (row) => row.userId === uid['adminA'] && row.readAt === null,
      ),
    ).toEqual([]);

    // More than an hour later, a new request is its own notification again.
    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    expect((await submit('Six')).status).toBe(201);
    items = (await feed(ADMIN2)).data;
    expect(items.map((item) => item.is_summary)).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// Post-commit, rollback, retry — DOCUMENT 19 rules 2 and 9
// ---------------------------------------------------------------------------

describe('post-commit delivery, rollback and retry', () => {
  it('a rolled-back change notifies no one and records no event', async () => {
    const events = async () =>
      asOwner(() => prisma.notificationEvent.count({ where: { companyId: COMPANY_A } }));
    const before = await events();
    await withTrigger('tasks', 'INSERT', async () => {
      const response = await (await api(ADMIN_A)).post('/tasks').send({
        title: 'Never saved',
        assignee_employee_id: emp['worker'],
        priority: 'low',
      });
      expect(response.status).toBe(500);
    });
    expect(await everyNotification()).toEqual([]);
    expect(await events()).toBe(before);
  });

  it('a failed notification never fails the committed change; the retry delivers it exactly once', async () => {
    let taskId = '';
    await withTrigger('notifications', 'INSERT', async () => {
      taskId = await createTask(ADMIN_A, emp['worker'] as string, { title: 'Retry me' });
    });
    // The task committed; the notification did not, and was queued — not lost.
    expect(
      await withTenant(prisma, COMPANY_A, (tx) => tx.task.count({ where: { id: taskId } })),
    ).toBe(1);
    expect(await everyNotification()).toEqual([]);
    expect(notificationQueue.batches).toHaveLength(1);
    const batch = notificationQueue.batches[0] as QueuedBatch;
    expect(batch.companyId).toBe(COMPANY_A);
    expect(batch.events[0]).toMatchObject({ type: 'task_assigned', taskId });

    // The retry worker's processing, twice: one notification.
    const pipeline = app.get(NotificationPipeline);
    expect(await pipeline.processQueued(batch)).toEqual({ processed: 1, dispatched: 1 });
    expect(await pipeline.processQueued(batch)).toEqual({ processed: 0, dispatched: 0 });
    await expectExactly('task_assigned', ids('worker'), { relatedType: 'task', relatedId: taskId });
  });
});

// ---------------------------------------------------------------------------
// Retention — DOCUMENT 19 rule 8
// ---------------------------------------------------------------------------

describe('retention: twelve months, then purged', () => {
  it('deletes only what is older than twelve months, company by company, idempotently', async () => {
    const cutoff = retentionCutoff(NOW);
    expect(cutoff.toISOString()).toBe('2025-05-10T08:00:00.000Z');
    const make = async (companyId: string, userId: string, createdAt: Date) => {
      const id = generateId();
      await withTenant(prisma, companyId, (tx) =>
        tx.notification.create({
          data: {
            id,
            companyId,
            userId,
            type: 'task_updated',
            priority: 'low',
            audience: 'employee',
            titleAr: 'تم تحديث مهمة',
            titleEn: 'Task updated',
            bodyAr: 'تم.',
            bodyEn: 'Done.',
            relatedType: 'task',
            relatedId: generateId(),
            createdAt,
          },
        }),
      );
      return id;
    };
    const expired = await make(COMPANY_A, uid['worker'] as string, new Date(cutoff.getTime() - 1));
    const kept = await make(COMPANY_A, uid['worker'] as string, new Date(cutoff.getTime() + 1));
    const otherCompany = await make(
      COMPANY_B,
      uid['workerB'] as string,
      new Date(cutoff.getTime() - 1),
    );

    const retention = app.get(NotificationRetention);
    const first = await retention.purgeCompany(COMPANY_A, NOW);
    expect(first.notifications).toBe(1);
    const left = (await everyNotification()).map((row) => row.id);
    expect(left).toContain(kept);
    expect(left).toContain(otherCompany);
    expect(left).not.toContain(expired);
    expect((await retention.purgeCompany(COMPANY_A, NOW)).notifications).toBe(0);

    const all = await retention.purgeAll(NOW);
    expect(all.get(COMPANY_B)?.notifications).toBe(1);
    expect((await everyNotification()).map((row) => row.id)).toEqual([kept]);
  });
});

// ---------------------------------------------------------------------------
// Company preferences — DOCUMENT 19 rule 10
// ---------------------------------------------------------------------------

describe('company notification settings', () => {
  it('an admin turns a type off for the company (audited); a manager may not', async () => {
    const admin = await api(ADMIN_A);
    const listed = await admin.get('/settings/notifications');
    expect(listed.status).toBe(200);
    expect((listed.body.data as unknown[]).length).toBe(24);
    expect(listed.body.data[0]).toMatchObject({
      type: 'leave_request_submitted',
      channels: [{ channel: 'in_app', enabled: true }],
    });
    expect(
      (
        await (await api(MANAGER)).patch('/settings/notifications').send({
          preferences: [{ type: 'task_updated', channel: 'in_app', enabled: false }],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.patch('/settings/notifications').send({
          preferences: [{ type: 'task_updated', channel: 'email', enabled: true }],
        })
      ).status,
    ).toBe(422);

    const off = await admin.patch('/settings/notifications').send({
      preferences: [{ type: 'task_updated', channel: 'in_app', enabled: false }],
    });
    expect(off.status).toBe(200);
    const audit = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { action: 'SETTINGS_NOTIFICATION_CHANGED' } }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.newValues).toEqual({ 'task_updated.in_app': false });

    const id = await createTask(ADMIN_A, emp['worker'] as string);
    await clearNotifications();
    await admin.patch(`/tasks/${id}`).send({ title: 'Quietly renamed' });
    expect(await ofType('task_updated')).toEqual([]);

    await admin.patch('/settings/notifications').send({
      preferences: [{ type: 'task_updated', channel: 'in_app', enabled: true }],
    });
    await admin.patch(`/tasks/${id}`).send({ title: 'Loudly renamed' });
    await expectExactly('task_updated', ids('worker'), { relatedType: 'task' });
  });
});
