/**
 * Phase 7 end-to-end — DOCUMENT 25 Phase 7, DOCUMENT 13, DOCUMENT 26.
 *
 * Exit criterion: *"progress calculation is correct in every checklist
 * scenario, and invalid status transitions are rejected server-side."* Both
 * clauses are proved here over HTTP against the real application:
 *
 *   - **every checklist scenario** — tick, untick, re-tick (idempotent), add,
 *     delete an open item, delete a ticked item, delete every item (the
 *     no-checklist fallback), DOCUMENT 13's own 6-of-8 example, thirds,
 *     a checklist added after completion, and the OD-10 status rule for a
 *     task with no checklist at all.
 *   - **invalid transitions rejected server-side** — all 25 (from, to) pairs
 *     are attempted, each on a fresh task driven to `from` through allowed
 *     moves; exactly the nine DOCUMENT 13 rule 4 transitions succeed, and
 *     every other one is a 422 that names the allowed transitions and leaves
 *     the task untouched.
 *
 * Around those: permissions and scope for all three roles, tenant isolation,
 * overdue derivation, soft delete, append-only progress history and the
 * DOCUMENT 21 audit trail.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced (the connection runs as `ufuq_app`). Only Redis and mail
 * are fakes, as in every earlier suite. `Date` is fixed at Tuesday
 * 2026-03-10, 10:00 Cairo, so "today" and "overdue" are deterministic.
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
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import { STATUS_TRANSITIONS, TASK_STATUSES } from '../src/tasks/task-rules.js';
import type { TaskStatusValue } from '../src/tasks/task-rules.js';

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

let managerEmployeeId = '';
let workerEmployeeId = '';
let outsiderEmployeeId = '';
let inactiveEmployeeId = '';
let workerBId = '';
let departmentAId = '';
let otherDepartmentAId = '';

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

/** Tuesday 2026-03-10, 10:00 in Cairo (UTC+2 in March). */
const NOW = new Date(Date.UTC(2026, 2, 10, 8, 0, 0));
const TODAY = '2026-03-10';
const YESTERDAY = '2026-03-09';
const TOMORROW = '2026-03-11';

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
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.init();

  prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures();
  // From here on the application runs as the restricted role, exactly as in
  // production: row-level security is enforced on every query below.
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  const admin = await api(ADMIN_A);
  departmentAId = (
    await admin.post('/departments').send({ name_ar: 'هندسة', name_en: 'Engineering' })
  ).body.data.id as string;
  otherDepartmentAId = (
    await admin.post('/departments').send({ name_ar: 'مبيعات', name_en: 'Sales' })
  ).body.data.id as string;
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

  managerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Mona',
    last_name: 'Saleh',
    email: MANAGER.email,
    employee_code: 'MGR-1',
    role_key: 'manager',
    department_id: departmentAId,
    work_schedule_id: scheduleId,
  });
  workerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Omar',
    last_name: 'Fathy',
    email: WORKER.email,
    employee_code: 'EMP-1',
    role_key: 'employee',
    department_id: departmentAId,
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  outsiderEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Layla',
    last_name: 'Nabil',
    email: OUTSIDER.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    department_id: otherDepartmentAId,
    work_schedule_id: scheduleId,
  });
  inactiveEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Sami',
    last_name: 'Adel',
    email: 'inactive@a.test',
    employee_code: 'EMP-3',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  await activate(MANAGER);
  await activate(WORKER);
  await activate(OUTSIDER);
  const deactivated = await admin
    .post(`/employees/${inactiveEmployeeId}/deactivate`)
    .send({ reason: 'Left the company' });
  expect(deactivated.status).toBe(200);

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
    put: (path: string) => auth(agent.put(`/${API_PREFIX}${path}`)),
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

interface TaskBody {
  readonly id: string;
  readonly status: TaskStatusValue;
  readonly progress_percent: string;
  readonly is_overdue: boolean;
  readonly completed_at: string | null;
  readonly cancelled_reason: string | null;
  readonly checklist_total: number;
  readonly checklist_completed: number;
  readonly allowed_transitions: TaskStatusValue[];
  readonly department: { id: string } | null;
  readonly assignee: { id: string; status: string };
  readonly deadline: string | null;
  readonly checklist: { id: string; title: string; is_completed: boolean; position: number }[];
}

async function createTask(
  body: Record<string, unknown> = {},
  account: Account = ADMIN_A,
): Promise<TaskBody> {
  const response = await (await api(account)).post('/tasks').send({
    title: 'Prepare the quarterly report',
    priority: 'medium',
    assignee_employee_id: workerEmployeeId,
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`Task create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as TaskBody;
}

async function getTask(id: string, account: Account = ADMIN_A): Promise<TaskBody> {
  const response = await (await api(account)).get(`/tasks/${id}`);
  expect(response.status).toBe(200);
  return response.body.data as TaskBody;
}

async function setStatus(
  id: string,
  status: TaskStatusValue,
  extra: Record<string, unknown> = {},
  account: Account = ADMIN_A,
) {
  return (await api(account)).post(`/tasks/${id}/status`).send({ status, ...extra });
}

async function tick(id: string, itemId: string, isCompleted: boolean, account: Account = WORKER) {
  const response = await (await api(account))
    .patch(`/tasks/${id}/checklist/${itemId}`)
    .send({ is_completed: isCompleted });
  expect(response.status).toBe(200);
  return response.body.data as TaskBody;
}

async function auditsFor(taskId: string, action: AuditAction) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({
      where: { entityType: 'task', entityId: taskId, action },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

/** Drives a fresh no-checklist task to `status` through allowed moves only. */
async function taskIn(status: TaskStatusValue): Promise<TaskBody> {
  const task = await createTask({ title: `Task in ${status}` });
  const path: Record<TaskStatusValue, TaskStatusValue[]> = {
    not_started: [],
    in_progress: ['in_progress'],
    on_hold: ['on_hold'],
    completed: ['in_progress', 'completed'],
    cancelled: ['cancelled'],
  };
  for (const step of path[status]) {
    const response = await setStatus(task.id, step, { reason: 'Fixture' });
    expect(response.status).toBe(200);
  }
  return getTask(task.id);
}

// ---------------------------------------------------------------------------
// Exit criterion, clause 1 — progress in every checklist scenario
// ---------------------------------------------------------------------------

describe('progress — every checklist scenario (DOCUMENT 13 rules 2, 3, 5; OD-10)', () => {
  it('walks tick, untick, re-tick, add, delete open, delete ticked, and delete all', async () => {
    const task = await createTask({ checklist: ['Collect', 'Draft', 'Review', 'Send'] });
    expect(task.status).toBe('not_started');
    expect(task.progress_percent).toBe('0.00');
    expect(task.checklist.map((item) => item.position)).toEqual([0, 1, 2, 3]);
    const [a, b, c, d] = task.checklist.map((item) => item.id) as [string, string, string, string];

    // First tick: 1 of 4, and the task starts (rule 5).
    let now = await tick(task.id, a, true);
    expect(now.progress_percent).toBe('25.00');
    expect(now.status).toBe('in_progress');
    expect(await auditsFor(task.id, 'TASK_STATUS_CHANGED')).toHaveLength(1);

    now = await tick(task.id, b, true);
    expect(now.progress_percent).toBe('50.00');
    now = await tick(task.id, c, true);
    expect(now.progress_percent).toBe('75.00');

    // Untick.
    now = await tick(task.id, c, false);
    expect(now.progress_percent).toBe('50.00');
    expect(now.status).toBe('in_progress');

    // Ticking an already-ticked item is idempotent: success, no change, no
    // extra audit record (DOCUMENT 13 "two users tick simultaneously").
    const updatesBefore = (await auditsFor(task.id, 'TASK_UPDATED')).length;
    now = await tick(task.id, b, true);
    expect(now.progress_percent).toBe('50.00');
    expect(await auditsFor(task.id, 'TASK_UPDATED')).toHaveLength(updatesBefore);

    now = await tick(task.id, c, true);
    expect(now.progress_percent).toBe('75.00');

    // Add an open item — the denominator grows (FLOW 11): 3 of 5.
    const added = await (await api(ADMIN_A))
      .post(`/tasks/${task.id}/checklist`)
      .send({ title: 'Archive' });
    expect(added.status).toBe(201);
    expect(added.body.data.progress_percent).toBe('60.00');
    const e = (added.body.data as TaskBody).checklist.find((item) => item.title === 'Archive');
    expect(e?.position).toBe(4);

    // Delete the open item: back to 3 of 4.
    expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}/checklist/${e?.id}`)).status).toBe(
      204,
    );
    expect((await getTask(task.id)).progress_percent).toBe('75.00');

    // Delete a ticked item: 2 of 3, rounded half up.
    expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}/checklist/${c}`)).status).toBe(
      204,
    );
    expect((await getTask(task.id)).progress_percent).toBe('66.67');

    now = await tick(task.id, d, true);
    expect(now.progress_percent).toBe('100.00');
    // 100% by checklist does not complete the task — only a status change does.
    expect(now.status).toBe('in_progress');

    // Delete every item: no division by zero; the OD-10 status rule applies
    // to an in-progress task.
    for (const id of [a, b, d]) {
      expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}/checklist/${id}`)).status).toBe(
        204,
      );
    }
    now = await getTask(task.id);
    expect(now.checklist_total).toBe(0);
    expect(now.progress_percent).toBe('50.00');

    expect(await auditsFor(task.id, 'CHECKLIST_ITEM_ADDED')).toHaveLength(1);
    expect(await auditsFor(task.id, 'CHECKLIST_ITEM_DELETED')).toHaveLength(5);
  });

  it('is DOCUMENT 13’s own example: 6 of 8 → 75%', async () => {
    const task = await createTask({
      checklist: Array.from({ length: 8 }, (_, i) => `Step ${String(i + 1)}`),
    });
    let now = task;
    for (const item of task.checklist.slice(0, 6)) {
      now = await tick(task.id, item.id, true);
    }
    expect(now.checklist_completed).toBe(6);
    expect(now.progress_percent).toBe('75.00');
  });

  it('stores thirds exactly: 1 of 3 → 33.33, 2 of 3 → 66.67', async () => {
    const task = await createTask({ checklist: ['One', 'Two', 'Three'] });
    const [one, two] = task.checklist;
    expect((await tick(task.id, one?.id ?? '', true)).progress_percent).toBe('33.33');
    expect((await tick(task.id, two?.id ?? '', true)).progress_percent).toBe('66.67');
    const stored = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.task.findUniqueOrThrow({ where: { id: task.id }, select: { progressPercent: true } }),
    );
    expect(stored.progressPercent.toString()).toBe('66.67');
  });

  it('a task with no checklist follows status: 0 → 50 → 50 on hold → 100 → 50 reopened', async () => {
    const task = await createTask();
    expect(task.progress_percent).toBe('0.00');
    expect((await setStatus(task.id, 'in_progress')).body.data.progress_percent).toBe('50.00');
    expect((await setStatus(task.id, 'on_hold')).body.data.progress_percent).toBe('50.00');
    expect((await setStatus(task.id, 'in_progress')).body.data.progress_percent).toBe('50.00');
    expect((await setStatus(task.id, 'completed')).body.data.progress_percent).toBe('100.00');
    const reopened = await setStatus(task.id, 'in_progress', {
      reason: 'Client asked for changes',
    });
    expect(reopened.body.data.progress_percent).toBe('50.00');
  });

  it('on hold and cancelled keep the progress a task already had', async () => {
    const paused = await createTask();
    expect((await setStatus(paused.id, 'on_hold')).body.data.progress_percent).toBe('0.00');

    const cancelled = await createTask();
    await setStatus(cancelled.id, 'in_progress');
    const response = await setStatus(cancelled.id, 'cancelled', { reason: 'No longer needed' });
    expect(response.body.data.progress_percent).toBe('50.00');
  });

  it('a checklist added after completion recalculates progress; the task stays completed', async () => {
    const task = await createTask();
    await setStatus(task.id, 'in_progress');
    expect((await setStatus(task.id, 'completed')).body.data.progress_percent).toBe('100.00');

    const added = await (await api(ADMIN_A))
      .post(`/tasks/${task.id}/checklist`)
      .send({ title: 'Late step' });
    expect(added.status).toBe(201);
    expect(added.body.data.progress_percent).toBe('0.00');
    expect(added.body.data.status).toBe('completed');
  });

  it('the first progress note starts the task and records the progress at that moment', async () => {
    const task = await createTask();
    const note = await (await api(WORKER))
      .post(`/tasks/${task.id}/progress-updates`)
      .send({ note: 'أنهيت التصاميم الأولية وأرسلتها للمدير' });
    expect(note.status).toBe(201);
    expect(note.body.data.progress_percent_at_time).toBe('50.00');
    expect(note.body.data.author.employee_id).toBe(workerEmployeeId);

    const now = await getTask(task.id);
    expect(now.status).toBe('in_progress');
    expect(now.progress_percent).toBe('50.00');
    expect(await auditsFor(task.id, 'TASK_STATUS_CHANGED')).toHaveLength(1);
  });

  it('progress cannot be written by a client, on create or on edit', async () => {
    const create = await (await api(ADMIN_A)).post('/tasks').send({
      title: 'Typed progress',
      priority: 'low',
      assignee_employee_id: workerEmployeeId,
      progress_percent: '90.00',
    });
    expect(create.status).toBe(422);
    expect(create.body.error.fields).toHaveProperty('progress_percent');

    const task = await createTask();
    const patch = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}`)
      .send({ progress_percent: '90.00' });
    expect(patch.status).toBe(422);
    expect((await getTask(task.id)).progress_percent).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Exit criterion, clause 2 — invalid transitions rejected server-side
// ---------------------------------------------------------------------------

describe('status transitions — the full 5 × 5 matrix (DOCUMENT 13 rule 4)', () => {
  const pairs = TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', async (from, to) => {
    const task = await taskIn(from);
    expect(task.status).toBe(from);
    const allowed = STATUS_TRANSITIONS[from].includes(to);

    // A reason and the open-items confirmation are always supplied, so the
    // only thing deciding the outcome is the matrix.
    const response = await setStatus(task.id, to, {
      reason: 'Matrix check',
      confirm_open_items: true,
    });

    if (allowed) {
      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(to);
    } else {
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect(response.body.error.fields.status).toEqual(['invalid_transition']);
      // "422 explaining the allowed transitions".
      expect(response.body.error.fields.allowed_transitions).toEqual([...STATUS_TRANSITIONS[from]]);
      expect(response.body.error.message_ar).toEqual(expect.any(String));
      expect(response.body.error.message_en).toEqual(expect.any(String));
      // Not a silent no-op, and not a partial write either.
      const after = await getTask(task.id);
      expect(after.status).toBe(from);
      expect(after.progress_percent).toBe(task.progress_percent);
    }
  });

  it('exposes the allowed transitions on every task, matching the matrix', async () => {
    for (const status of TASK_STATUSES) {
      const task = await taskIn(status);
      expect(task.allowed_transitions).toEqual([...STATUS_TRANSITIONS[status]]);
    }
  });

  it('refuses a status that is not in the enum — there is no settable overdue', async () => {
    const task = await createTask();
    const response = await setStatus(task.id, 'overdue' as TaskStatusValue);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a status change through PATCH — the matrix cannot be bypassed', async () => {
    const task = await createTask();
    const response = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}`)
      .send({ status: 'completed' });
    expect(response.status).toBe(422);
    expect((await getTask(task.id)).status).toBe('not_started');
  });

  it('cancelling requires a reason, stores it, and is audited as task.cancelled', async () => {
    const task = await createTask();
    for (const reason of [undefined, '', '   ']) {
      const refused = await setStatus(task.id, 'cancelled', reason === undefined ? {} : { reason });
      expect(refused.status).toBe(422);
      expect(refused.body.error.fields.reason).toEqual(['required']);
    }
    expect((await getTask(task.id)).status).toBe('not_started');

    const response = await setStatus(task.id, 'cancelled', { reason: 'Client withdrew' });
    expect(response.status).toBe(200);
    expect(response.body.data.cancelled_reason).toBe('Client withdrew');
    const [audit] = await auditsFor(task.id, 'TASK_CANCELLED');
    expect(audit?.newValues).toMatchObject({
      status: 'cancelled',
      cancelled_reason: 'Client withdrew',
    });
  });

  it('completing a cancelled task is 422 — cancelled is terminal', async () => {
    const task = await taskIn('cancelled');
    const response = await setStatus(task.id, 'completed', { confirm_open_items: true });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.allowed_transitions).toEqual([]);
  });

  it('reopening requires a reason, clears completed_at and is audited as task.reopened', async () => {
    const task = await taskIn('completed');
    expect(task.completed_at).toBe(NOW.toISOString());

    const refused = await setStatus(task.id, 'in_progress');
    expect(refused.status).toBe(422);
    expect(refused.body.error.fields.reason).toEqual(['required']);

    const response = await setStatus(task.id, 'in_progress', { reason: 'Found a mistake' });
    expect(response.status).toBe(200);
    expect(response.body.data.completed_at).toBeNull();
    const [audit] = await auditsFor(task.id, 'TASK_REOPENED');
    expect(audit?.oldValues).toMatchObject({ status: 'completed' });
    expect(audit?.newValues).toMatchObject({ status: 'in_progress', reason: 'Found a mistake' });
  });

  it('completing with open items needs confirmation naming the count (rule 6)', async () => {
    const task = await createTask({ checklist: ['One', 'Two', 'Three'] });
    await tick(task.id, task.checklist[0]?.id ?? '', true);

    const first = await setStatus(task.id, 'completed', {}, WORKER);
    expect(first.status).toBe(409);
    expect(first.body.error.code).toBe('TASK_HAS_OPEN_ITEMS');
    expect(first.body.error.fields.open_items).toEqual(['2']);
    expect((await getTask(task.id)).status).toBe('in_progress');

    const confirmed = await setStatus(task.id, 'completed', { confirm_open_items: true }, WORKER);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('completed');
    // Progress still follows the checklist, not the status.
    expect(confirmed.body.data.progress_percent).toBe('33.33');
    expect(await auditsFor(task.id, 'TASK_STATUS_CHANGED')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Create / edit / delete
// ---------------------------------------------------------------------------

describe('create and edit (DOCUMENT 13 validation, FLOW 09)', () => {
  it('creates a not-started task, defaulting the department to the assignee’s', async () => {
    const task = await createTask({ checklist: ['  Spaced  ', 'Second'] });
    expect(task.status).toBe('not_started');
    expect(task.department?.id).toBe(departmentAId);
    expect(task.checklist.map((item) => item.title)).toEqual(['Spaced', 'Second']);
    const [audit] = await auditsFor(task.id, 'TASK_CREATED');
    expect(audit?.newValues).toMatchObject({ status: 'not_started', checklist_items: '2' });
  });

  it('lets the department be overridden, or cleared', async () => {
    expect((await createTask({ department_id: otherDepartmentAId })).department?.id).toBe(
      otherDepartmentAId,
    );
    expect((await createTask({ department_id: null })).department).toBeNull();
  });

  it('allows a deadline in the past (back-dated work)', async () => {
    const task = await createTask({ deadline: YESTERDAY });
    expect(task.deadline).toBe(YESTERDAY);
    expect(task.is_overdue).toBe(true);
  });

  it.each([
    ['a two-character title', { title: 'ab' }, 'title'],
    ['a title of spaces', { title: '     ' }, 'title'],
    ['a 256-character title', { title: 'x'.repeat(256) }, 'title'],
    ['a missing priority', { priority: undefined }, 'priority'],
    ['an unknown priority', { priority: 'critical' }, 'priority'],
    ['an invalid date', { deadline: '2026-02-30' }, 'deadline'],
    ['a company_id', { company_id: COMPANY_B }, 'company_id'],
    ['a status', { status: 'in_progress' }, 'status'],
    ['a goal_id (Phase 8)', { goal_id: generateId() }, 'goal_id'],
    ['an empty checklist item', { checklist: ['   '] }, 'checklist'],
    ['a 256-character checklist item', { checklist: ['x'.repeat(256)] }, 'checklist'],
  ])('refuses %s with 422', async (_label, override, field) => {
    const response = await (await api(ADMIN_A)).post('/tasks').send({
      title: 'Valid title',
      priority: 'high',
      assignee_employee_id: workerEmployeeId,
      ...override,
    });
    expect(response.status).toBe(422);
    expect(
      Object.keys(response.body.error.fields as object).some((key) => key.startsWith(field)),
    ).toBe(true);
  });

  it('refuses a deadline before the start date, and accepts the same day', async () => {
    const response = await (await api(ADMIN_A)).post('/tasks').send({
      title: 'Dated',
      priority: 'low',
      assignee_employee_id: workerEmployeeId,
      start_date: TOMORROW,
      deadline: TODAY,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.fields.deadline).toEqual(['end_before_start']);
    expect((await createTask({ start_date: TODAY, deadline: TODAY })).deadline).toBe(TODAY);
  });

  it('requires an active assignee inside the company and the caller’s scope', async () => {
    const attempt = async (account: Account, assignee: string) =>
      (await api(account))
        .post('/tasks')
        .send({ title: 'Scoped', priority: 'low', assignee_employee_id: assignee });

    // Deactivated: named, so the screen can say "الموظف غير نشط".
    const inactive = await attempt(ADMIN_A, inactiveEmployeeId);
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.fields.assignee_employee_id).toEqual(['not_active']);

    // Another company's employee, or one that does not exist: not found.
    for (const id of [workerBId, generateId()]) {
      const response = await attempt(ADMIN_A, id);
      expect(response.status).toBe(422);
      expect(response.body.error.fields.assignee_employee_id).toEqual(['not_found']);
    }

    // A manager assigns within their team only.
    expect((await attempt(MANAGER, workerEmployeeId)).status).toBe(201);
    const outside = await attempt(MANAGER, outsiderEmployeeId);
    expect(outside.status).toBe(422);
    expect(outside.body.error.fields.assignee_employee_id).toEqual(['not_found']);
  });

  it('audits each kind of edit under its own DOCUMENT 21 action', async () => {
    const task = await createTask({ deadline: YESTERDAY });
    const response = await (await api(ADMIN_A)).patch(`/tasks/${task.id}`).send({
      title: 'Renamed task',
      priority: 'urgent',
      assignee_employee_id: outsiderEmployeeId,
      deadline: TOMORROW,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.assignee.id).toBe(outsiderEmployeeId);
    expect(response.body.data.is_overdue).toBe(false);

    const [updated] = await auditsFor(task.id, 'TASK_UPDATED');
    expect(updated?.oldValues).toEqual({
      title: 'Prepare the quarterly report',
      priority: 'medium',
    });
    expect(updated?.newValues).toEqual({ title: 'Renamed task', priority: 'urgent' });

    const [reassigned] = await auditsFor(task.id, 'TASK_REASSIGNED');
    expect(reassigned?.oldValues).toEqual({ assignee_employee_id: workerEmployeeId });
    expect(reassigned?.newValues).toEqual({ assignee_employee_id: outsiderEmployeeId });

    // Rule 11: a deadline change on an overdue task, with old and new values.
    const [deadline] = await auditsFor(task.id, 'TASK_DEADLINE_CHANGED');
    expect(deadline?.oldValues).toEqual({ deadline: YESTERDAY });
    expect(deadline?.newValues).toEqual({ deadline: TOMORROW });
  });

  it('refuses reassignment to a deactivated employee, and edits that break the date order', async () => {
    const task = await createTask({ start_date: TODAY });
    const inactive = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}`)
      .send({ assignee_employee_id: inactiveEmployeeId });
    expect(inactive.status).toBe(422);
    expect(inactive.body.error.fields.assignee_employee_id).toEqual(['not_active']);

    const dates = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}`)
      .send({ deadline: YESTERDAY });
    expect(dates.status).toBe(422);
    expect(dates.body.error.fields.deadline).toEqual(['end_before_start']);
  });

  it('soft-deletes: 204, then 404 and absent from lists, with the row and an audit kept', async () => {
    const task = await createTask({ title: 'To be deleted', checklist: ['Kept with the task'] });
    expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}`)).status).toBe(204);
    expect((await (await api(ADMIN_A)).get(`/tasks/${task.id}`)).status).toBe(404);
    const list = await (await api(ADMIN_A)).get('/tasks?per_page=100');
    expect((list.body.data as TaskBody[]).some((row) => row.id === task.id)).toBe(false);

    const row = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.task.findUniqueOrThrow({ where: { id: task.id }, include: { checklistItems: true } }),
    );
    expect(row.deletedAt).not.toBeNull();
    expect(row.checklistItems).toHaveLength(1);
    expect(await auditsFor(task.id, 'TASK_DELETED')).toHaveLength(1);
    // Deleting it again finds nothing to delete.
    expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Checklist and progress-note details
// ---------------------------------------------------------------------------

describe('checklist and progress notes', () => {
  it('reorders an item and keeps positions dense', async () => {
    const task = await createTask({ checklist: ['A', 'B', 'C', 'D'] });
    const d = task.checklist[3]?.id ?? '';
    const moved = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}/checklist/${d}`)
      .send({ position: 0 });
    expect(moved.status).toBe(200);
    const after = moved.body.data as TaskBody;
    expect(after.checklist.map((item) => item.title)).toEqual(['D', 'A', 'B', 'C']);
    expect(after.checklist.map((item) => item.position)).toEqual([0, 1, 2, 3]);

    // A position past the end moves it last.
    const last = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}/checklist/${d}`)
      .send({ position: 99 });
    expect((last.body.data as TaskBody).checklist.map((item) => item.title)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('renames an item; an item of another task is 404', async () => {
    const task = await createTask({ checklist: ['Old name'] });
    const other = await createTask({ checklist: ['Elsewhere'] });
    const id = task.checklist[0]?.id ?? '';
    const renamed = await (await api(ADMIN_A))
      .patch(`/tasks/${task.id}/checklist/${id}`)
      .send({ title: 'New name' });
    expect((renamed.body.data as TaskBody).checklist[0]?.title).toBe('New name');

    const crossed = await (await api(ADMIN_A))
      .patch(`/tasks/${other.id}/checklist/${id}`)
      .send({ is_completed: true });
    expect(crossed.status).toBe(404);
    expect((await (await api(ADMIN_A)).delete(`/tasks/${other.id}/checklist/${id}`)).status).toBe(
      404,
    );
  });

  it('refuses an empty checklist PATCH and a 256-character title', async () => {
    const task = await createTask({ checklist: ['Item'] });
    const id = task.checklist[0]?.id ?? '';
    expect(
      (await (await api(ADMIN_A)).patch(`/tasks/${task.id}/checklist/${id}`).send({})).status,
    ).toBe(422);
    expect(
      (
        await (await api(ADMIN_A))
          .post(`/tasks/${task.id}/checklist`)
          .send({ title: 'x'.repeat(256) })
      ).status,
    ).toBe(422);
  });

  it('validates progress notes: required, not whitespace, at most 2000 characters', async () => {
    const task = await createTask();
    for (const note of ['', '    ', 'x'.repeat(2001)]) {
      const response = await (await api(WORKER))
        .post(`/tasks/${task.id}/progress-updates`)
        .send({ note });
      expect(response.status).toBe(422);
    }
    expect(
      (
        await (await api(WORKER))
          .post(`/tasks/${task.id}/progress-updates`)
          .send({ note: 'x'.repeat(2000) })
      ).status,
    ).toBe(201);
  });

  it('lists progress history newest first, and an admin without an employee record can write it', async () => {
    const task = await createTask();
    await (await api(WORKER)).post(`/tasks/${task.id}/progress-updates`).send({ note: 'First' });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const admin = await (await api(ADMIN_A))
      .post(`/tasks/${task.id}/progress-updates`)
      .send({ note: 'Second' });
    vi.setSystemTime(NOW);
    expect(admin.status).toBe(201);
    expect(admin.body.data.author.employee_id).toBeNull();
    expect(admin.body.data.author.name).toBe(ADMIN_A.email);

    const list = await (await api(WORKER)).get(`/tasks/${task.id}/progress-updates`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((u: { note: string }) => u.note)).toEqual(['Second', 'First']);
    expect(list.body.meta.total).toBe(2);
  });

  it('progress history is append-only — there is no route to edit or delete it', async () => {
    const task = await createTask();
    const note = await (await api(ADMIN_A))
      .post(`/tasks/${task.id}/progress-updates`)
      .send({ note: 'Fixed' });
    const id = note.body.data.id as string;
    expect(
      (
        await (await api(ADMIN_A))
          .patch(`/tasks/${task.id}/progress-updates/${id}`)
          .send({ note: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await (await api(ADMIN_A)).delete(`/tasks/${task.id}/progress-updates/${id}`)).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Permissions, scope and tenancy
// ---------------------------------------------------------------------------

describe('permissions and scope (DOCUMENT 02 "Tasks", DOCUMENT 13)', () => {
  let workerTask: TaskBody;
  let outsiderTask: TaskBody;
  let inactiveTask: TaskBody;

  beforeAll(async () => {
    workerTask = await createTask({ title: 'Worker’s task', checklist: ['Do it'] });
    outsiderTask = await createTask({
      title: 'Outsider’s task',
      assignee_employee_id: outsiderEmployeeId,
    });
    // Assigned while active, so it survives the deactivation as an open task.
    inactiveTask = await withTenant(prisma, COMPANY_A, async (tx) => {
      const id = generateId();
      const creator = await tx.user.findFirstOrThrow({ where: { email: ADMIN_A.email } });
      await tx.task.create({
        data: {
          id,
          companyId: COMPANY_A,
          title: 'Left behind',
          assigneeEmployeeId: inactiveEmployeeId,
          priority: 'low',
          createdBy: creator.id,
        },
      });
      return { id } as TaskBody;
    });
  });

  it('an employee sees only their own tasks; another employee’s task is 404', async () => {
    const list = await (await api(WORKER)).get('/tasks?per_page=100');
    expect(list.status).toBe(200);
    const assignees = new Set((list.body.data as TaskBody[]).map((task) => task.assignee.id));
    expect([...assignees]).toEqual([workerEmployeeId]);

    expect((await (await api(WORKER)).get(`/tasks/${outsiderTask.id}`)).status).toBe(404);
    expect(
      (await (await api(WORKER)).get(`/tasks/${outsiderTask.id}/progress-updates`)).status,
    ).toBe(404);
    expect((await setStatus(outsiderTask.id, 'in_progress', {}, WORKER)).status).toBe(404);
  });

  it('an employee cannot create, edit, reassign, re-deadline, delete or change the checklist list', async () => {
    const worker = await api(WORKER);
    expect(
      (
        await worker
          .post('/tasks')
          .send({ title: 'Mine', priority: 'low', assignee_employee_id: workerEmployeeId })
      ).status,
    ).toBe(403);
    expect(
      (await worker.patch(`/tasks/${workerTask.id}`).send({ deadline: TOMORROW })).status,
    ).toBe(403);
    expect((await worker.delete(`/tasks/${workerTask.id}`)).status).toBe(403);
    expect(
      (await worker.post(`/tasks/${workerTask.id}/checklist`).send({ title: 'More' })).status,
    ).toBe(403);
    const itemId = workerTask.checklist[0]?.id ?? '';
    expect((await worker.delete(`/tasks/${workerTask.id}/checklist/${itemId}`)).status).toBe(403);
    expect(
      (await worker.patch(`/tasks/${workerTask.id}/checklist/${itemId}`).send({ title: 'Renamed' }))
        .status,
    ).toBe(403);
    expect(
      (await worker.patch(`/tasks/${workerTask.id}/checklist/${itemId}`).send({ position: 0 }))
        .status,
    ).toBe(403);
  });

  it('an employee may tick, add notes and change status on their own task', async () => {
    const itemId = workerTask.checklist[0]?.id ?? '';
    expect((await tick(workerTask.id, itemId, true)).progress_percent).toBe('100.00');
    expect(
      (
        await (await api(WORKER))
          .post(`/tasks/${workerTask.id}/progress-updates`)
          .send({ note: 'Done' })
      ).status,
    ).toBe(201);
    expect((await setStatus(workerTask.id, 'completed', {}, WORKER)).status).toBe(200);
  });

  it('a manager reaches their team’s tasks and nobody else’s', async () => {
    const list = await (await api(MANAGER)).get('/tasks?per_page=100');
    const assignees = new Set((list.body.data as TaskBody[]).map((task) => task.assignee.id));
    expect(assignees.has(workerEmployeeId)).toBe(true);
    expect(assignees.has(outsiderEmployeeId)).toBe(false);

    expect((await (await api(MANAGER)).get(`/tasks/${workerTask.id}`)).status).toBe(200);
    expect((await (await api(MANAGER)).get(`/tasks/${outsiderTask.id}`)).status).toBe(404);
    expect(
      (await (await api(MANAGER)).patch(`/tasks/${outsiderTask.id}`).send({ priority: 'low' }))
        .status,
    ).toBe(404);
    // Reassigning a team task outside the team is refused.
    const out = await (await api(MANAGER))
      .patch(`/tasks/${workerTask.id}`)
      .send({ assignee_employee_id: outsiderEmployeeId });
    expect(out.status).toBe(422);
  });

  it('filters narrow a scope and never widen it', async () => {
    const response = await (
      await api(WORKER)
    ).get(`/tasks?assignee_employee_id=${outsiderEmployeeId}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it('a task whose assignee was deactivated stays, visible to the admin and still reassignable', async () => {
    const task = await getTask(inactiveTask.id);
    expect(task.assignee.id).toBe(inactiveEmployeeId);
    const reassigned = await (await api(ADMIN_A))
      .patch(`/tasks/${inactiveTask.id}`)
      .send({ assignee_employee_id: workerEmployeeId });
    expect(reassigned.status).toBe(200);
  });

  it('another company cannot see, change or even confirm a task exists', async () => {
    const other = await api(ADMIN_B);
    expect((await other.get(`/tasks/${workerTask.id}`)).status).toBe(404);
    expect((await other.patch(`/tasks/${workerTask.id}`).send({ priority: 'low' })).status).toBe(
      404,
    );
    expect(
      (
        await other
          .post(`/tasks/${workerTask.id}/status`)
          .send({ status: 'in_progress', reason: 'x' })
      ).status,
    ).toBe(404);
    expect((await other.delete(`/tasks/${workerTask.id}`)).status).toBe(404);
    expect(
      (await other.post(`/tasks/${workerTask.id}/progress-updates`).send({ note: 'x' })).status,
    ).toBe(404);
    const list = await other.get('/tasks');
    expect(list.body.data).toEqual([]);
    expect(list.body.meta.total).toBe(0);
    const summary = await other.get('/tasks/summary');
    expect(summary.body.data.total).toBe(0);
  });

  it('never accepts company_id from the client', async () => {
    const response = await (await api(ADMIN_A)).get(`/tasks?company_id=${COMPANY_B}`);
    expect(response.status).toBe(422);
  });

  it('requires a session, and refuses malformed ids', async () => {
    expect((await request(server()).get(`/${API_PREFIX}/tasks`)).status).toBe(401);
    expect((await (await api(ADMIN_A)).get('/tasks/not-a-uuid')).status).toBe(400);
  });

  it('records every task action against the task, readable as its history', async () => {
    const history = await (
      await api(ADMIN_A)
    ).get(`/audit-logs/entity/task/${workerTask.id}?per_page=100`);
    expect(history.status).toBe(200);
    const actions = (history.body.data as { action: string }[]).map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['task.created', 'task.updated', 'task.status_changed']),
    );
  });
});

// ---------------------------------------------------------------------------
// Overdue and summary
// ---------------------------------------------------------------------------

describe('overdue derivation and the summary (DOCUMENT 13 rule 1)', () => {
  it('is derived from the company’s calendar day and never stored', async () => {
    const overdue = await createTask({
      title: 'Late work',
      deadline: YESTERDAY,
      assignee_employee_id: outsiderEmployeeId,
    });
    const dueToday = await createTask({
      title: 'Due today',
      deadline: TODAY,
      assignee_employee_id: outsiderEmployeeId,
    });
    const finished = await taskIn('completed');
    await (await api(ADMIN_A)).patch(`/tasks/${finished.id}`).send({ deadline: YESTERDAY });

    expect((await getTask(overdue.id)).is_overdue).toBe(true);
    expect((await getTask(dueToday.id)).is_overdue).toBe(false);
    expect((await getTask(finished.id)).is_overdue).toBe(false);

    const onlyOverdue = await (await api(ADMIN_A)).get('/tasks?overdue=true&per_page=100');
    const ids = (onlyOverdue.body.data as TaskBody[]).map((task) => task.id);
    expect(ids).toContain(overdue.id);
    expect(ids).not.toContain(dueToday.id);
    expect(ids).not.toContain(finished.id);
    expect((onlyOverdue.body.data as TaskBody[]).every((task) => task.is_overdue)).toBe(true);

    const notOverdue = await (await api(ADMIN_A)).get('/tasks?overdue=false&per_page=100');
    const notIds = (notOverdue.body.data as TaskBody[]).map((task) => task.id);
    expect(notIds).not.toContain(overdue.id);
    expect(notIds).toContain(dueToday.id);
    expect(notIds).toContain(finished.id);

    // The next morning, the task due today becomes overdue with no write. A
    // session opened at that moment is used, so the cached ones — idle for 20
    // hours from that clock's point of view — are not expired by the check.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 6, 0, 0)));
    try {
      tokens.delete(ADMIN_A.email);
      expect((await getTask(dueToday.id)).is_overdue).toBe(true);
    } finally {
      tokens.delete(ADMIN_A.email);
      vi.setSystemTime(NOW);
    }
  });

  it('filters by status, priority, department and the deadline range', async () => {
    const urgent = await createTask({
      title: 'Urgent sales task',
      priority: 'urgent',
      department_id: otherDepartmentAId,
      deadline: '2026-04-15',
    });
    const admin = await api(ADMIN_A);
    const byPriority = await admin.get('/tasks?priority=urgent&per_page=100');
    expect((byPriority.body.data as TaskBody[]).map((t) => t.id)).toContain(urgent.id);
    const byDepartment = await admin.get(`/tasks?department_id=${otherDepartmentAId}&per_page=100`);
    expect(
      (byDepartment.body.data as TaskBody[]).every((t) => t.department?.id === otherDepartmentAId),
    ).toBe(true);
    const inRange = await admin.get('/tasks?from=2026-04-01&to=2026-04-30&per_page=100');
    expect((inRange.body.data as TaskBody[]).map((t) => t.id)).toEqual([urgent.id]);
    const byStatus = await admin.get('/tasks?status=cancelled&per_page=100');
    expect((byStatus.body.data as TaskBody[]).every((t) => t.status === 'cancelled')).toBe(true);
    expect((await admin.get('/tasks?overdue=yes')).status).toBe(422);
  });

  it('counts tasks by status, overdue and due today, within the caller’s scope', async () => {
    const admin = await (await api(ADMIN_A)).get('/tasks/summary');
    expect(admin.status).toBe(200);
    const data = admin.body.data as {
      total: number;
      by_status: Record<TaskStatusValue, number>;
      overdue: number;
      due_today: number;
    };
    // Each count must equal the matching filtered list's total — the same
    // scope and the same overdue rule, counted two different ways.
    const total = async (query: string): Promise<number> =>
      (await (await api(ADMIN_A)).get(`/tasks?${query}`)).body.meta.total as number;
    expect(data.total).toBe(await total('per_page=1'));
    for (const status of TASK_STATUSES) {
      expect(data.by_status[status]).toBe(await total(`status=${status}`));
    }
    expect(data.overdue).toBe(await total('overdue=true'));
    const today = await (await api(ADMIN_A)).get(`/tasks?from=${TODAY}&to=${TODAY}&per_page=100`);
    expect(data.due_today).toBe(
      (today.body.data as TaskBody[]).filter((task) =>
        ['not_started', 'in_progress', 'on_hold'].includes(task.status),
      ).length,
    );
    expect(data.due_today).toBeGreaterThan(0);
    expect(data.overdue).toBeGreaterThan(0);

    const mine = await (await api(WORKER)).get('/tasks/summary');
    const myList = await (await api(WORKER)).get('/tasks?per_page=100');
    expect(mine.body.data.total).toBe(myList.body.meta.total);
    expect(mine.body.data.total).toBeLessThan(data.total);
  });
});

// ---------------------------------------------------------------------------
// Tasks needing reassignment (DOCUMENT 13 edge case) and the profile's list
// ---------------------------------------------------------------------------

describe('tasks needing reassignment and the per-employee list', () => {
  let leaverId = '';
  let open: TaskBody;
  let paused: TaskBody;
  let done: TaskBody;

  beforeAll(async () => {
    leaverId = await createEmployee(ADMIN_A, {
      first_name: 'Hana',
      last_name: 'Leaving',
      email: 'leaver@a.test',
      employee_code: 'EMP-9',
      role_key: 'employee',
      manager_id: managerEmployeeId,
      work_schedule_id: (
        await withTenant(prisma, COMPANY_A, (tx) =>
          tx.workSchedule.findFirstOrThrow({ select: { id: true } }),
        )
      ).id,
    });
    open = await createTask({ title: 'Open when they left', assignee_employee_id: leaverId });
    paused = await createTask({ title: 'Paused when they left', assignee_employee_id: leaverId });
    await setStatus(paused.id, 'on_hold');
    done = await taskIn('completed');
    await (await api(ADMIN_A)).patch(`/tasks/${done.id}`).send({ assignee_employee_id: leaverId });
    const deactivated = await (await api(ADMIN_A))
      .post(`/employees/${leaverId}/deactivate`)
      .send({ reason: 'Resigned' });
    expect(deactivated.status).toBe(200);
  });

  it('lists exactly the open tasks of employees who are no longer active', async () => {
    const response = await (await api(ADMIN_A)).get('/tasks?needs_reassignment=true&per_page=100');
    expect(response.status).toBe(200);
    const rows = response.body.data as TaskBody[];
    const ids = rows.map((task) => task.id);
    expect(ids).toContain(open.id);
    expect(ids).toContain(paused.id);
    // Completed work needs nobody.
    expect(ids).not.toContain(done.id);
    // Every row's assignee is inactive and every row is open.
    expect(rows.every((task) => task.assignee.status !== 'active')).toBe(true);
    expect(rows.every((task) => !['completed', 'cancelled'].includes(task.status))).toBe(true);
  });

  it('a task leaves the list once it is reassigned to an active employee', async () => {
    const moved = await createTask({ title: 'Moved on', assignee_employee_id: workerEmployeeId });
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.task.update({ where: { id: moved.id }, data: { assigneeEmployeeId: leaverId } }),
    );
    let ids = (
      (await (await api(ADMIN_A)).get('/tasks?needs_reassignment=true&per_page=100')).body
        .data as TaskBody[]
    ).map((task) => task.id);
    expect(ids).toContain(moved.id);

    const reassigned = await (await api(ADMIN_A))
      .patch(`/tasks/${moved.id}`)
      .send({ assignee_employee_id: workerEmployeeId });
    expect(reassigned.status).toBe(200);
    ids = (
      (await (await api(ADMIN_A)).get('/tasks?needs_reassignment=true&per_page=100')).body
        .data as TaskBody[]
    ).map((task) => task.id);
    expect(ids).not.toContain(moved.id);
  });

  it('stays inside the caller’s scope: a manager sees their team, an employee nothing of others', async () => {
    const team = await (await api(MANAGER)).get('/tasks?needs_reassignment=true&per_page=100');
    expect((team.body.data as TaskBody[]).map((task) => task.id)).toContain(open.id);

    const worker = await (await api(WORKER)).get('/tasks?needs_reassignment=true');
    expect(worker.status).toBe(200);
    expect(worker.body.data).toEqual([]);

    const other = await (await api(ADMIN_B)).get('/tasks?needs_reassignment=true');
    expect(other.body.data).toEqual([]);
  });

  it('refuses any value but true', async () => {
    expect((await (await api(ADMIN_A)).get('/tasks?needs_reassignment=false')).status).toBe(422);
  });

  it('the profile list: one employee’s tasks, still narrowed by the caller’s scope', async () => {
    const admin = await (
      await api(ADMIN_A)
    ).get(`/tasks?assignee_employee_id=${leaverId}&status=on_hold&per_page=100`);
    expect((admin.body.data as TaskBody[]).map((task) => task.id)).toEqual([paused.id]);

    // A manager asking about someone outside their team gets nothing.
    const outside = await (
      await api(MANAGER)
    ).get(`/tasks?assignee_employee_id=${outsiderEmployeeId}&per_page=100`);
    expect(outside.body.data).toEqual([]);
  });
});
