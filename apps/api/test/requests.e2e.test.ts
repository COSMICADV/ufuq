/**
 * Phase 9 end-to-end — DOCUMENT 25 Phase 9, DOCUMENT 08 §4.9, DOCUMENT 04
 * B13 / C8–C10, OD-03 and OD-09 (approved), DOCUMENT 26.
 *
 * Exit criterion (DOCUMENT 25, as amended in Phase 9): Attendance, Salary,
 * Task and General can each be submitted, reviewed, approved, rejected and
 * cancelled, with reasons enforced — proved here over HTTP. Leave exists as
 * an integration boundary only and is refused until Phase 10 completes its
 * specialised lifecycle.
 *
 * Around it: list filters, scope (employee self, manager team, admin
 * company), OD-03 self-review refusal for a manager and for an admin,
 * terminal states, the attendance-correction integration (decisions delegated
 * to the Phase 6 logic, the inbox row kept in step by the database), request
 * attachments, the pending count, tenant isolation and the DOCUMENT 21 trail.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced (the connection runs as `ufuq_app`). Redis, mail, object
 * storage and the request event sink are fakes. `Date` is fixed at Tuesday
 * 2026-03-10, 10:00 Cairo.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import { REQUEST_EVENT_SINK } from '../src/requests/request-events.js';
import type { RequestEvent, RequestEventSink } from '../src/requests/request-events.js';

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

class CapturingSink implements RequestEventSink {
  readonly events: RequestEvent[] = [];
  handle(event: RequestEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
const sink = new CapturingSink();

const COMPANY_A = generateId();
const COMPANY_B = generateId();
/** A company whose only ADMIN is also its only employee — the OD-03 V1 fallback. */
const COMPANY_C = generateId();

const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };
/** An ADMIN who is also an employee — the OD-03 admin case. */
const ADMIN_EMP = { email: 'admin-emp@a.test', password: 'admin-emp-password-2026' };
const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };
const OUTSIDER = { email: 'outsider@a.test', password: 'outsider-password-2026' };
const WORKER_B = { email: 'worker@b.test', password: 'worker-b-password-2026' };
const SOLE_ADMIN = { email: 'sole@c.test', password: 'sole-admin-password-2026' };
const SECOND_ADMIN = { email: 'second@c.test', password: 'second-admin-password-2026' };

let adminEmployeeId = '';
let managerEmployeeId = '';
let workerEmployeeId = '';
let outsiderEmployeeId = '';
let workerTaskId = '';
let outsiderTaskId = '';
let taskBId = '';

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
    [COMPANY_C, 'company-c', SOLE_ADMIN],
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
    .overrideProvider(REQUEST_EVENT_SINK)
    .useValue(sink)
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

  adminEmployeeId = await createEmployee(ADMIN_A, {
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
  outsiderEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Layla',
    last_name: 'Nabil',
    email: OUTSIDER.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    work_schedule_id: scheduleId,
  });
  await activate(ADMIN_EMP);
  await activate(MANAGER);
  await activate(WORKER);
  await activate(OUTSIDER);

  workerTaskId = await createTask(ADMIN_A, workerEmployeeId);
  outsiderTaskId = await createTask(ADMIN_A, outsiderEmployeeId);

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
  const workerBId = await createEmployee(ADMIN_B, {
    first_name: 'Other',
    last_name: 'Person',
    email: WORKER_B.email,
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB.body.data.id as string,
  });
  await activate(WORKER_B);
  taskBId = await createTask(ADMIN_B, workerBId);
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

async function createTask(account: Account, assignee: string): Promise<string> {
  const response = await (await api(account))
    .post('/tasks')
    .send({ title: 'Prepare the report', priority: 'medium', assignee_employee_id: assignee });
  if (response.status !== 201) {
    throw new Error(`Task create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as string;
}

interface RequestBody {
  readonly id: string;
  readonly category: string;
  readonly status: string;
  readonly subject: string | null;
  readonly description: string | null;
  readonly employee: { id: string };
  readonly related_type: string | null;
  readonly related_id: string | null;
  readonly task: { id: string; title: string } | null;
  readonly attendance: {
    id: string;
    date: string;
    status: string;
    review_note: string | null;
    current: { status: string; check_in_at: string | null } | null;
  } | null;
  readonly reviewed_by: { user_id: string; name: string } | null;
  readonly reviewed_at: string | null;
  readonly admin_response: string | null;
  readonly created_at: string;
  readonly is_own: boolean;
  readonly abilities: { can_review: boolean; can_cancel: boolean };
  readonly attachments?: { id: string }[];
  readonly attachment_abilities?: { can_upload: boolean; can_delete: boolean };
}

async function submit(account: Account, body: Record<string, unknown> = {}): Promise<RequestBody> {
  const response = await (await api(account)).post('/requests').send({
    category: 'general',
    subject: 'Parking permit',
    description: 'I need a parking permit for March.',
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`Request submit failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as RequestBody;
}

async function getRequest(id: string, account: Account = ADMIN_A): Promise<RequestBody> {
  const response = await (await api(account)).get(`/requests/${id}`);
  expect(response.status).toBe(200);
  return response.body.data as RequestBody;
}

async function decide(
  account: Account,
  id: string,
  action: 'approve' | 'reject' | 'cancel',
  body: Record<string, unknown> = {},
) {
  return (await api(account)).post(`/requests/${id}/${action}`).send(body);
}

async function list(account: Account, query: Record<string, string> = {}) {
  const response = await (await api(account)).get('/requests').query({ per_page: '100', ...query });
  expect(response.status).toBe(200);
  return response.body as { data: RequestBody[]; meta: { total: number } };
}

async function auditsFor(entityType: string, entityId: string, action: AuditAction) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({
      where: { entityType, entityId, action },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

async function correction(account: Account, date: string): Promise<string> {
  const response = await (await api(account)).post('/attendance-corrections').send({
    date,
    requested_check_in: `${date}T07:00:00.000Z`,
    requested_check_out: `${date}T15:00:00.000Z`,
    requested_work_mode: 'office',
    reason: 'I forgot to check in',
  });
  if (response.status !== 201) {
    throw new Error(`Correction failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data.id as string;
}

async function inboxRowFor(correctionId: string, account: Account = ADMIN_A): Promise<RequestBody> {
  const page = await list(account, { category: 'attendance' });
  const row = page.data.find((item) => item.related_id === correctionId);
  if (row === undefined) throw new Error(`No inbox row for correction ${correctionId}`);
  return row;
}

async function uploadTo(account: Account, requestId: string) {
  redis.reset();
  return (await api(account))
    .post('/attachments')
    .field('related_type', 'request')
    .field('related_id', requestId)
    .attach('file', SAMPLES.pdf.bytes, { filename: SAMPLES.pdf.name, contentType: PDF_MIME });
}

// ---------------------------------------------------------------------------
// Submitting — DOCUMENT 04 C9, DOCUMENT 08 §4.9
// ---------------------------------------------------------------------------

describe('submitting — native categories (salary, task, general)', () => {
  it('creates each native category Pending, audited, and published after commit', async () => {
    for (const category of ['salary', 'task', 'general'] as const) {
      const created = await submit(WORKER, { category, subject: `A ${category} request` });
      expect(created).toMatchObject({
        category,
        status: 'pending',
        subject: `A ${category} request`,
        employee: { id: workerEmployeeId },
        reviewed_by: null,
        reviewed_at: null,
        admin_response: null,
        is_own: true,
        abilities: { can_review: false, can_cancel: true },
      });
      const audits = await auditsFor('request', created.id, 'REQUEST_SUBMITTED');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.newValues).toMatchObject({ category });
    }
    expect(sink.events.map((event) => [event.type, event.category])).toEqual([
      ['request_submitted', 'salary'],
      ['request_submitted', 'task'],
      ['request_submitted', 'general'],
    ]);
  });

  it('a task request may name a task the requester can see — and only that', async () => {
    const ok = await submit(WORKER, { category: 'task', task_id: workerTaskId });
    expect(ok.task).toMatchObject({ id: workerTaskId, title: 'Prepare the report' });
    expect(ok.related_type).toBe('task');

    const worker = await api(WORKER);
    for (const taskId of [outsiderTaskId, taskBId]) {
      const response = await worker
        .post('/requests')
        .send({ category: 'task', subject: 'x', description: 'y', task_id: taskId });
      expect(response.status).toBe(422);
      expect(response.body.error.fields.task_id).toEqual(['not_found']);
    }
    const wrongCategory = await worker
      .post('/requests')
      .send({ category: 'general', subject: 'x', description: 'y', task_id: workerTaskId });
    expect(wrongCategory.body.error.fields.task_id).toEqual(['invalid']);
  });

  it('attendance and leave are specialised (OD-09): not submittable as a bare request', async () => {
    const worker = await api(WORKER);
    for (const category of ['attendance', 'leave']) {
      const response = await worker
        .post('/requests')
        .send({ category, subject: 'x', description: 'y' });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('REQUEST_CATEGORY_SPECIALISED');
    }
  });

  it('validates input and never accepts an owner, status or company from the client', async () => {
    const worker = await api(WORKER);
    const blank = await worker
      .post('/requests')
      .send({ category: 'general', subject: '  ', description: 'y' });
    expect(blank.status).toBe(422);
    const missing = await worker.post('/requests').send({ category: 'salary', subject: 'x' });
    expect(missing.status).toBe(422);
    const unknown = await worker
      .post('/requests')
      .send({ category: 'vacation', subject: 'x', description: 'y' });
    expect(unknown.status).toBe(422);
    for (const extra of [
      { employee_id: outsiderEmployeeId },
      { status: 'approved' },
      { company_id: COMPANY_B },
    ]) {
      const response = await worker
        .post('/requests')
        .send({ category: 'general', subject: 'x', description: 'y', ...extra });
      expect(response.status).toBe(422);
    }
  });
});

// ---------------------------------------------------------------------------
// Listing and reading — DOCUMENT 02 scopes, DOCUMENT 08 §4.9 filters
// ---------------------------------------------------------------------------

describe('listing and reading — self, team, company; another tenant sees nothing', () => {
  it('the employee sees their own, the manager their team and themselves, the admin everyone', async () => {
    const mine = await submit(WORKER, { subject: 'Worker request' });
    const outsiders = await submit(OUTSIDER, { subject: 'Outsider request' });
    const managers = await submit(MANAGER, { subject: 'Manager request' });

    const worker = await list(WORKER);
    expect(worker.data.every((row) => row.employee.id === workerEmployeeId)).toBe(true);
    expect(worker.data.map((row) => row.id)).toContain(mine.id);

    const manager = await list(MANAGER);
    const managerIds = manager.data.map((row) => row.id);
    expect(managerIds).toContain(mine.id);
    expect(managerIds).toContain(managers.id);
    expect(managerIds).not.toContain(outsiders.id);

    const admin = await list(ADMIN_A);
    const adminIds = admin.data.map((row) => row.id);
    expect(adminIds).toEqual(expect.arrayContaining([mine.id, outsiders.id, managers.id]));

    expect((await list(ADMIN_B)).data).toEqual([]);
  });

  it('filters by category, status, employee and submission date — never wider than scope', async () => {
    const salary = await submit(WORKER, { category: 'salary', subject: 'Advance' });
    const bySalary = await list(ADMIN_A, { category: 'salary' });
    expect(bySalary.data.every((row) => row.category === 'salary')).toBe(true);
    expect(bySalary.data.map((row) => row.id)).toContain(salary.id);

    const pending = await list(ADMIN_A, { status: 'pending' });
    expect(pending.data.every((row) => row.status === 'pending')).toBe(true);

    const byEmployee = await list(ADMIN_A, { employee_id: outsiderEmployeeId });
    expect(byEmployee.data.every((row) => row.employee.id === outsiderEmployeeId)).toBe(true);

    expect(
      (await list(ADMIN_A, { from: '2026-03-10', to: '2026-03-10' })).data.map((r) => r.id),
    ).toContain(salary.id);
    expect((await list(ADMIN_A, { from: '2026-03-11' })).data).toEqual([]);
    expect((await list(ADMIN_A, { to: '2026-03-09' })).data.some((r) => r.id === salary.id)).toBe(
      false,
    );

    // A manager filtering by someone outside the team gets nothing, not their requests.
    expect((await list(MANAGER, { employee_id: outsiderEmployeeId })).data).toEqual([]);

    const bad = await (await api(ADMIN_A)).get('/requests').query({ category: 'vacation' });
    expect(bad.status).toBe(422);
  });

  it('detail: in scope 200; in-tenant out of scope 403; another company 404', async () => {
    const mine = await submit(WORKER);
    expect((await getRequest(mine.id, WORKER)).attachments).toEqual([]);
    expect((await getRequest(mine.id, MANAGER)).abilities.can_review).toBe(true);
    expect((await (await api(OUTSIDER)).get(`/requests/${mine.id}`)).status).toBe(403);
    expect((await (await api(ADMIN_B)).get(`/requests/${mine.id}`)).status).toBe(404);
    expect((await (await api(WORKER_B)).get(`/requests/${mine.id}`)).status).toBe(404);
    expect((await (await api(ADMIN_A)).get(`/requests/${generateId()}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Deciding — approve, reject, terminal states
// ---------------------------------------------------------------------------

describe('approving and rejecting', () => {
  it('a manager approves a team request: reviewer, time and response recorded, audited, published', async () => {
    const created = await submit(WORKER, { category: 'salary', subject: 'Salary certificate' });
    sink.events.length = 0;
    const response = await decide(MANAGER, created.id, 'approve', {
      admin_response: 'Ready Thursday',
    });
    expect(response.status).toBe(200);
    const body = response.body.data as RequestBody;
    expect(body).toMatchObject({
      status: 'approved',
      admin_response: 'Ready Thursday',
      reviewed_by: { name: 'Mona Saleh' },
      abilities: { can_review: false, can_cancel: false },
    });
    expect(body.reviewed_at).toBe(NOW.toISOString());

    const audits = await auditsFor('request', created.id, 'REQUEST_APPROVED');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.oldValues).toMatchObject({ status: 'pending' });
    expect(audits[0]?.newValues).toMatchObject({
      status: 'approved',
      admin_response: 'Ready Thursday',
    });
    expect(sink.events).toEqual([
      expect.objectContaining({
        type: 'request_reviewed',
        decision: 'approved',
        requestId: created.id,
      }),
    ]);
  });

  it('rejection requires a reason, and keeps it as the admin response', async () => {
    const created = await submit(WORKER, { category: 'general' });
    for (const body of [{}, { admin_response: '' }, { admin_response: '   ' }]) {
      const refused = await decide(ADMIN_A, created.id, 'reject', body);
      expect(refused.status).toBe(422);
    }
    expect((await getRequest(created.id)).status).toBe('pending');
    const rejected = await decide(ADMIN_A, created.id, 'reject', {
      admin_response: 'Not in policy',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data).toMatchObject({
      status: 'rejected',
      admin_response: 'Not in policy',
    });
    expect(await auditsFor('request', created.id, 'REQUEST_REJECTED')).toHaveLength(1);
  });

  it('a decided request takes no further decision and cannot be cancelled', async () => {
    const approved = await submit(WORKER);
    expect((await decide(MANAGER, approved.id, 'approve')).status).toBe(200);
    for (const [action, body] of [
      ['approve', {}],
      ['reject', { admin_response: 'Changed my mind' }],
    ] as const) {
      const again = await decide(ADMIN_A, approved.id, action, body);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('REQUEST_NOT_PENDING');
    }
    const cancel = await decide(WORKER, approved.id, 'cancel');
    expect(cancel.status).toBe(409);
    expect((await getRequest(approved.id)).status).toBe('approved');
  });

  it('only reviewers decide, and only within their scope', async () => {
    const outsiders = await submit(OUTSIDER);
    const workers = await submit(WORKER);
    // An employee holds no request.review (DOCUMENT 02).
    expect((await decide(WORKER, workers.id, 'approve')).status).toBe(403);
    // A manager's team does not include the outsider.
    expect((await decide(MANAGER, outsiders.id, 'approve')).status).toBe(403);
    // Another company cannot even find it.
    expect((await decide(ADMIN_B, workers.id, 'approve')).status).toBe(404);
    expect((await decide(ADMIN_B, workers.id, 'reject', { admin_response: 'no' })).status).toBe(
      404,
    );
    expect((await getRequest(workers.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// OD-03 — nobody reviews their own request
// ---------------------------------------------------------------------------

describe('OD-03 — self-review is refused on the server', () => {
  it('a manager cannot approve or reject their own request; an ADMIN can', async () => {
    const own = await submit(MANAGER, { category: 'salary', subject: 'My advance' });
    expect((await getRequest(own.id, MANAGER)).abilities.can_review).toBe(false);
    for (const [action, body] of [
      ['approve', {}],
      ['reject', { admin_response: 'x' }],
    ] as const) {
      const response = await decide(MANAGER, own.id, action, body);
      expect(response.status).toBe(403);
    }
    expect((await decide(ADMIN_A, own.id, 'approve')).status).toBe(200);
  });

  it('an ADMIN who is also an employee cannot decide their own request; another ADMIN can', async () => {
    const own = await submit(ADMIN_EMP, { category: 'general', subject: 'Laptop' });
    expect(own.employee.id).toBe(adminEmployeeId);
    expect(own.abilities.can_review).toBe(false);
    const approve = await decide(ADMIN_EMP, own.id, 'approve');
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('REQUEST_SELF_REVIEW');
    const reject = await decide(ADMIN_EMP, own.id, 'reject', { admin_response: 'x' });
    expect(reject.body.error.code).toBe('REQUEST_SELF_REVIEW');
    expect((await getRequest(own.id)).status).toBe('pending');
    expect((await getRequest(own.id, ADMIN_A)).abilities.can_review).toBe(true);
    expect((await decide(ADMIN_A, own.id, 'approve')).status).toBe(200);
  });

  it('the same rule holds for attendance corrections, on both endpoints', async () => {
    const id = await correction(ADMIN_EMP, '2026-03-04');
    const direct = await (await api(ADMIN_EMP))
      .post(`/attendance-corrections/${id}/approve`)
      .send({});
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('REQUEST_SELF_REVIEW');
    const row = await inboxRowFor(id);
    const viaInbox = await decide(ADMIN_EMP, row.id, 'approve');
    expect(viaInbox.body.error.code).toBe('REQUEST_SELF_REVIEW');
    expect((await getRequest(row.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Cancelling — own, pending only
// ---------------------------------------------------------------------------

describe('cancelling', () => {
  it('the requester cancels their own pending request; it is audited', async () => {
    const created = await submit(WORKER);
    const response = await decide(WORKER, created.id, 'cancel');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'cancelled', reviewed_at: null });
    expect(await auditsFor('request', created.id, 'REQUEST_CANCELLED')).toHaveLength(1);
    const again = await decide(WORKER, created.id, 'cancel');
    expect(again.status).toBe(409);
    expect((await decide(ADMIN_A, created.id, 'approve')).status).toBe(409);
  });

  it('nobody cancels somebody else’s request — not a colleague, not their manager', async () => {
    const created = await submit(WORKER);
    expect((await decide(OUTSIDER, created.id, 'cancel')).status).toBe(403);
    expect((await decide(MANAGER, created.id, 'cancel')).status).toBe(403);
    expect((await decide(ADMIN_EMP, created.id, 'cancel')).status).toBe(403);
    expect((await decide(ADMIN_B, created.id, 'cancel')).status).toBe(404);
    expect((await getRequest(created.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Attendance corrections in the unified centre — OD-09 hybrid model
// ---------------------------------------------------------------------------

describe('attendance corrections — indexed, and decided by the Phase 6 logic', () => {
  it('a correction appears in the inbox with its attendance context', async () => {
    const id = await correction(WORKER, '2026-03-09');
    const row = await inboxRowFor(id);
    expect(row).toMatchObject({
      category: 'attendance',
      status: 'pending',
      related_type: 'attendance_correction_request',
      employee: { id: workerEmployeeId },
      attendance: { id, date: '2026-03-09', status: 'pending' },
    });
    expect((await inboxRowFor(id, MANAGER)).abilities.can_review).toBe(true);
    expect((await list(WORKER, { category: 'attendance' })).data.map((r) => r.id)).toContain(
      row.id,
    );
    expect((await list(ADMIN_B, { category: 'attendance' })).data).toEqual([]);
  });

  it('approving in the centre applies the correction in one transaction', async () => {
    const id = await correction(WORKER, '2026-03-08');
    const row = await inboxRowFor(id);
    const response = await decide(MANAGER, row.id, 'approve', { admin_response: 'Confirmed' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'approved',
      admin_response: 'Confirmed',
      reviewed_by: { name: 'Mona Saleh' },
      attendance: { status: 'approved', review_note: 'Confirmed' },
    });
    // The attendance record was written by the correction's own logic.
    const record = (response.body.data as RequestBody).attendance?.current;
    expect(record?.check_in_at).toBe('2026-03-08T07:00:00.000Z');
    expect(
      await auditsFor('attendance_correction_request', id, 'ATTENDANCE_CORRECTION_APPROVED'),
    ).toHaveLength(1);
    // The native request actions are not used for a correction.
    expect(await auditsFor('request', row.id, 'REQUEST_APPROVED')).toHaveLength(0);
    expect((await decide(ADMIN_A, row.id, 'approve')).status).toBe(409);
  });

  it('rejecting in the centre needs a reason and rejects the correction', async () => {
    const id = await correction(WORKER, '2026-03-05');
    const row = await inboxRowFor(id);
    expect((await decide(MANAGER, row.id, 'reject', {})).status).toBe(422);
    const response = await decide(MANAGER, row.id, 'reject', { admin_response: 'No evidence' });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: 'rejected',
      admin_response: 'No evidence',
      attendance: { status: 'rejected', review_note: 'No evidence' },
    });
  });

  it('cancelling in the centre cancels the correction; a decision on the Phase 6 endpoint shows here', async () => {
    const cancelled = await correction(WORKER, '2026-03-04');
    const cancelledRow = await inboxRowFor(cancelled);
    expect((await decide(MANAGER, cancelledRow.id, 'cancel')).status).toBe(403);
    expect((await decide(WORKER, cancelledRow.id, 'cancel')).status).toBe(200);
    expect((await getRequest(cancelledRow.id)).attendance?.status).toBe('cancelled');
    expect(
      await auditsFor('attendance_correction_request', cancelled, 'REQUEST_CANCELLED'),
    ).toHaveLength(1);

    const direct = await correction(WORKER, '2026-03-03');
    const rejected = await (await api(ADMIN_A))
      .post(`/attendance-corrections/${direct}/reject`)
      .send({ review_note: 'Duplicate' });
    expect(rejected.status).toBe(200);
    const row = await inboxRowFor(direct);
    expect(row).toMatchObject({ status: 'rejected', admin_response: 'Duplicate' });
  });
});

// ---------------------------------------------------------------------------
// Attachments — the Phase 7 store, authorised by the request
// ---------------------------------------------------------------------------

describe('attachments follow the request’s own reach', () => {
  it('the requester attaches to their pending request; reviewers in scope can read it', async () => {
    const created = await submit(WORKER, { category: 'salary' });
    const uploaded = await uploadTo(WORKER, created.id);
    expect(uploaded.status).toBe(201);
    const fileId = uploaded.body.data.id as string;

    const detail = await getRequest(created.id, MANAGER);
    expect(detail.attachments?.map((file) => file.id)).toEqual([fileId]);
    expect(detail.attachment_abilities).toEqual({ can_upload: false, can_delete: false });
    expect((await getRequest(created.id, WORKER)).attachment_abilities).toEqual({
      can_upload: true,
      can_delete: true,
    });

    expect((await (await api(MANAGER)).get(`/attachments/${fileId}`)).status).toBe(200);
    expect((await (await api(ADMIN_A)).get(`/attachments/${fileId}`)).status).toBe(200);
    // Outside the request's reach, the file does not exist.
    expect((await (await api(OUTSIDER)).get(`/attachments/${fileId}`)).status).toBe(404);
    expect((await (await api(ADMIN_B)).get(`/attachments/${fileId}`)).status).toBe(404);
    // Nobody but the requester adds files, and nobody once it is decided.
    expect((await uploadTo(MANAGER, created.id)).status).toBe(403);
    expect((await uploadTo(OUTSIDER, created.id)).status).toBe(404);
    expect((await decide(MANAGER, created.id, 'approve')).status).toBe(200);
    expect((await uploadTo(WORKER, created.id)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The pending count — DOCUMENT 08 §4.9 badge, DOCUMENT 04 C1 component 7
// ---------------------------------------------------------------------------

describe('GET /requests/pending-count', () => {
  it('a reviewer counts what awaits their decision; an employee counts their own', async () => {
    const before = {
      worker: (await (await api(WORKER)).get('/requests/pending-count')).body.data,
      manager: (await (await api(MANAGER)).get('/requests/pending-count')).body.data,
      admin: (await (await api(ADMIN_A)).get('/requests/pending-count')).body.data,
      adminB: (await (await api(ADMIN_B)).get('/requests/pending-count')).body.data,
    };
    expect(before.worker.basis).toBe('own');
    expect(before.manager.basis).toBe('review');

    await submit(WORKER);
    await submit(OUTSIDER);
    await submit(MANAGER);

    const worker = (await (await api(WORKER)).get('/requests/pending-count')).body.data;
    const manager = (await (await api(MANAGER)).get('/requests/pending-count')).body.data;
    const admin = (await (await api(ADMIN_A)).get('/requests/pending-count')).body.data;
    const adminB = (await (await api(ADMIN_B)).get('/requests/pending-count')).body.data;
    expect(worker.count).toBe(before.worker.count + 1);
    // The team's request counts; the outsider's is not theirs, and their own they cannot decide.
    expect(manager.count).toBe(before.manager.count + 1);
    expect(admin.count).toBe(before.admin.count + 3);
    expect(adminB).toEqual(before.adminB);

    const pending = await list(ADMIN_A, { status: 'pending' });
    expect(admin.count).toBe(pending.meta.total);
  });
});

// ---------------------------------------------------------------------------
// The admin dashboard's list — DOCUMENT 04 B1 widget 7
// ---------------------------------------------------------------------------

describe('GET /requests?reviewable=true — what the caller may decide', () => {
  it('is the pending-count population: in review scope, never the caller’s own', async () => {
    const team = await submit(WORKER, { subject: 'Team request' });
    const outsiders = await submit(OUTSIDER, { subject: 'Outsider request' });
    const managers = await submit(MANAGER, { subject: 'Manager request' });

    const manager = await list(MANAGER, { status: 'pending', reviewable: 'true' });
    const managerIds = manager.data.map((row) => row.id);
    expect(managerIds).toContain(team.id);
    expect(managerIds).not.toContain(outsiders.id);
    expect(managerIds).not.toContain(managers.id);
    expect(manager.data.every((row) => row.abilities.can_review)).toBe(true);
    const managerCount = (await (await api(MANAGER)).get('/requests/pending-count')).body.data;
    expect(manager.meta.total).toBe(managerCount.count);

    const adminEmp = await list(ADMIN_EMP, { status: 'pending', reviewable: 'true' });
    const adminIds = adminEmp.data.map((row) => row.id);
    expect(adminIds).toEqual(expect.arrayContaining([team.id, outsiders.id, managers.id]));
    expect(adminEmp.data.some((row) => row.employee.id === adminEmployeeId)).toBe(false);

    expect((await list(ADMIN_B, { reviewable: 'true' })).data).toEqual([]);
    // An employee reviews nothing.
    const worker = await (await api(WORKER)).get('/requests').query({ reviewable: 'true' });
    expect(worker.status).toBe(403);
    const bad = await (await api(ADMIN_A)).get('/requests').query({ reviewable: 'yes' });
    expect(bad.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// OD-03 V1 fallback — the only ADMIN is the requester
// ---------------------------------------------------------------------------

describe('OD-03 V1 fallback — the only eligible ADMIN is the requester', () => {
  it('submits, stays pending, can cancel, and is reviewed once another ADMIN exists', async () => {
    const sole = await api(SOLE_ADMIN);
    const schedule = await sole.post('/work-schedules').send({
      name: 'C week',
      timezone: CAIRO,
      grace_period_minutes: 15,
      break_minutes: 60,
      half_day_threshold_hours: '4.00',
      overtime_policy: 'paid',
      is_default: true,
      days: week(),
    });
    expect(schedule.status).toBe(201);
    // The sole ADMIN is also an employee of the company.
    await withTenant(prisma, COMPANY_C, async (tx) => {
      const user = await tx.user.findFirstOrThrow({ where: { email: SOLE_ADMIN.email } });
      await tx.employee.create({
        data: {
          id: generateId(),
          companyId: COMPANY_C,
          userId: user.id,
          employeeCode: 'C-ADM',
          firstName: 'Sole',
          lastName: 'Admin',
          email: SOLE_ADMIN.email,
          workScheduleId: schedule.body.data.id as string,
          joiningDate: new Date('2026-01-05T00:00:00Z'),
        },
      });
    });

    const first = await submit(SOLE_ADMIN, { category: 'salary', subject: 'Salary certificate' });
    const second = await submit(SOLE_ADMIN, { category: 'general', subject: 'New laptop' });
    expect(first.status).toBe('pending');

    // Nobody can decide it: the requester is refused, and there is nobody else.
    expect((await decide(SOLE_ADMIN, first.id, 'approve')).body.error.code).toBe(
      'REQUEST_SELF_REVIEW',
    );
    expect(
      (await decide(SOLE_ADMIN, first.id, 'reject', { admin_response: 'x' })).body.error.code,
    ).toBe('REQUEST_SELF_REVIEW');
    expect((await getRequest(first.id, SOLE_ADMIN)).abilities).toEqual({
      can_review: false,
      can_cancel: true,
    });
    expect((await (await api(SOLE_ADMIN)).get('/requests/pending-count')).body.data).toEqual({
      count: 0,
      basis: 'review',
    });
    expect((await list(SOLE_ADMIN, { reviewable: 'true' })).data).toEqual([]);
    // Another company's ADMIN is not an eligible reviewer — it cannot even see it.
    expect((await decide(ADMIN_A, first.id, 'approve')).status).toBe(404);
    expect((await getRequest(first.id, SOLE_ADMIN)).status).toBe('pending');

    // The requester may still withdraw it while it is pending.
    expect((await decide(SOLE_ADMIN, second.id, 'cancel')).body.data.status).toBe('cancelled');

    // Once a second eligible ADMIN exists, the pending request can be reviewed.
    await createEmployee(SOLE_ADMIN, {
      first_name: 'Second',
      last_name: 'Admin',
      email: SECOND_ADMIN.email,
      employee_code: 'C-ADM-2',
      role_key: 'admin',
      work_schedule_id: schedule.body.data.id as string,
    });
    await activate(SECOND_ADMIN);
    expect((await getRequest(first.id, SECOND_ADMIN)).abilities.can_review).toBe(true);
    expect((await (await api(SECOND_ADMIN)).get('/requests/pending-count')).body.data.count).toBe(
      1,
    );
    const approved = await decide(SECOND_ADMIN, first.id, 'approve', { admin_response: 'Done' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({
      status: 'approved',
      reviewed_by: { name: 'Second Admin' },
    });
  });
});
