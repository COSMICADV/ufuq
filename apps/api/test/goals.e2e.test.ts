/**
 * Phase 8 end-to-end — DOCUMENT 25 Phase 8, DOCUMENT 14, DOCUMENT 26.
 *
 * Exit criterion: *"performance scores are computed entirely from
 * configuration, with no weight or coefficient present in code."* Proved here
 * over HTTP: the same employee's month scores differently under a different
 * saved configuration, by exactly the arithmetic the configuration implies.
 * (`performance-rules.test.ts` checks the engine's source for coefficients.)
 *
 * Around it: the three goal types, manual versus derived progress, the
 * progress formula and the display cap, append-only history, milestone
 * detection (published only after commit), the period-end close, task
 * completion and reopening recalculating a Task goal in the same transaction,
 * the permission matrix, scope, tenant isolation and the DOCUMENT 21 audit
 * trail.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced (the connection runs as `ufuq_app`). Redis, mail and the
 * milestone sink are fakes. `Date` is fixed at Tuesday 2026-03-10, 10:00 Cairo.
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
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { GOAL_EVENT_SINK } from '../src/goals/goal-events.js';
import type { GoalEventSink, GoalMilestoneEvent } from '../src/goals/goal-events.js';
import { GoalLifecycleService } from '../src/goals/goal-lifecycle.service.js';
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

class CapturingSink implements GoalEventSink {
  readonly events: GoalMilestoneEvent[] = [];
  milestonesReached(events: readonly GoalMilestoneEvent[]): Promise<void> {
    this.events.push(...events);
    return Promise.resolve();
  }
}
const sink = new CapturingSink();

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
let perfEmployeeId = '';
let newcomerEmployeeId = '';
let workerBId = '';

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
    .overrideProvider(GOAL_EVENT_SINK)
    .useValue(sink)
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
  inactiveEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Sami',
    last_name: 'Adel',
    email: 'inactive@a.test',
    employee_code: 'EMP-3',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  perfEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Ahmed',
    last_name: 'Mohamed',
    email: 'ahmed@a.test',
    employee_code: 'EMP-4',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
  });
  newcomerEmployeeId = await createEmployee(ADMIN_A, {
    first_name: 'Nour',
    last_name: 'Hassan',
    email: 'newcomer@a.test',
    employee_code: 'EMP-5',
    role_key: 'employee',
    manager_id: managerEmployeeId,
    work_schedule_id: scheduleId,
    joining_date: '2026-03-10',
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

interface GoalBody {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly unit: string;
  readonly target_value: string;
  readonly current_value: string;
  readonly progress_percent: string;
  readonly progress_display_percent: string;
  readonly days_remaining: number | null;
  readonly milestones_reached: number[];
  readonly milestones_crossed?: number[];
  readonly warnings?: string[];
  readonly possibly_misconfigured: boolean;
  readonly task_count_rule: { version: number; priorities: string[] } | null;
  readonly linked_tasks: { id: string; counts: boolean }[];
  readonly abilities: { can_edit: boolean; can_update_progress: boolean; can_cancel: boolean };
}

interface HistoryRow {
  readonly value: string;
  readonly previous_value: string | null;
  readonly target_value: string;
  readonly progress_percent: string;
  readonly source: string;
  readonly note: string | null;
}

async function createGoal(
  body: Record<string, unknown> = {},
  account: Account = ADMIN_A,
): Promise<GoalBody> {
  const response = await (await api(account)).post('/goals').send({
    employee_id: workerEmployeeId,
    type: 'sales',
    title: 'March sales',
    target_value: '100000',
    unit: 'EGP',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`Goal create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as GoalBody;
}

async function getGoal(id: string, account: Account = ADMIN_A): Promise<GoalBody> {
  const response = await (await api(account)).get(`/goals/${id}`);
  expect(response.status).toBe(200);
  return response.body.data as GoalBody;
}

async function history(id: string): Promise<HistoryRow[]> {
  const response = await (await api(ADMIN_A)).get(`/goals/${id}/progress`).query({ per_page: 100 });
  expect(response.status).toBe(200);
  return response.body.data as HistoryRow[];
}

async function progress(id: string, value: string, account: Account = ADMIN_A, note?: string) {
  return (await api(account))
    .post(`/goals/${id}/progress`)
    .send({ value, ...(note === undefined ? {} : { note }) });
}

async function createTask(
  body: Record<string, unknown>,
): Promise<{ id: string; warnings: string[] }> {
  const response = await (await api(ADMIN_A)).post('/tasks').send({
    title: 'Close a deal',
    priority: 'medium',
    assignee_employee_id: workerEmployeeId,
    ...body,
  });
  if (response.status !== 201) {
    throw new Error(`Task create failed: ${JSON.stringify(response.body)}`);
  }
  return response.body.data as { id: string; warnings: string[] };
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}) {
  const response = await (await api(ADMIN_A))
    .post(`/tasks/${id}/status`)
    .send({ status, ...extra });
  return response;
}

async function complete(id: string): Promise<void> {
  expect((await setStatus(id, 'in_progress')).status).toBe(200);
  expect((await setStatus(id, 'completed')).status).toBe(200);
}

async function auditsFor(entityType: string, entityId: string, action: AuditAction) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({
      where: { entityType, entityId, action },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

// ---------------------------------------------------------------------------
// Creation and validation — DOCUMENT 14 "Validation", FLOW 12
// ---------------------------------------------------------------------------

describe('creating goals — three types, DOCUMENT 14 validation', () => {
  it('creates a Sales goal at 0%, with its first history row and an audit record', async () => {
    const goal = await createGoal();
    expect(goal.type).toBe('sales');
    expect(goal.status).toBe('active');
    expect(goal.unit).toBe('EGP');
    expect(goal.target_value).toBe('100000.00');
    expect(goal.current_value).toBe('0.00');
    expect(goal.progress_percent).toBe('0.00');
    expect(goal.days_remaining).toBe(21);
    expect(goal.task_count_rule).toBeNull();
    expect(goal.abilities).toEqual({ can_edit: true, can_update_progress: true, can_cancel: true });

    const rows = await history(goal.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ value: '0.00', previous_value: null, source: 'manual' });
    expect(await auditsFor('goal', goal.id, 'GOAL_CREATED')).toHaveLength(1);
  });

  it('a Sales goal’s unit is the company currency — filled in when omitted, any other refused', async () => {
    const admin = await api(ADMIN_A);
    const base = {
      employee_id: workerEmployeeId,
      type: 'sales',
      title: 'Sales',
      target_value: '1000',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    };
    const omitted = await admin.post('/goals').send(base);
    expect(omitted.status).toBe(201);
    expect(omitted.body.data.unit).toBe('EGP');
    const wrong = await admin.post('/goals').send({ ...base, unit: 'USD' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.fields.unit).toEqual(['invalid']);
  });

  it('a Custom goal takes its own unit — a percentage-unit goal included', async () => {
    const goal = await createGoal({
      type: 'custom',
      title: 'Customer satisfaction',
      unit: '%',
      target_value: '90',
    });
    expect(goal.unit).toBe('%');
    const missing = await (await api(ADMIN_A)).post('/goals').send({
      employee_id: workerEmployeeId,
      type: 'custom',
      title: 'No unit',
      target_value: '90',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    });
    expect(missing.status).toBe(422);
  });

  it('a Task goal counts tasks, with a default rule; its target is a whole number', async () => {
    const goal = await createGoal({
      type: 'task',
      title: 'Close 20 tasks',
      target_value: '20',
      unit: undefined,
    });
    expect(goal.unit).toBe('tasks');
    expect(goal.task_count_rule).toEqual({
      version: 1,
      priorities: ['low', 'medium', 'high', 'urgent'],
    });
    expect(goal.abilities.can_update_progress).toBe(false);
    expect(goal.possibly_misconfigured).toBe(true);

    const admin = await api(ADMIN_A);
    const base = {
      employee_id: workerEmployeeId,
      type: 'task',
      title: 'Tasks',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    };
    const fractional = await admin.post('/goals').send({ ...base, target_value: '20.5' });
    expect(fractional.body.error.fields.target_value).toEqual(['invalid']);
    const badRule = await admin.post('/goals').send({
      ...base,
      target_value: '5',
      task_count_rule: { version: 1, priorities: ['critical'] },
    });
    expect(badRule.body.error.fields.task_count_rule).toEqual(['invalid']);
    const ruleOnSales = await admin.post('/goals').send({
      ...base,
      type: 'sales',
      unit: 'EGP',
      target_value: '5',
      task_count_rule: { version: 1, priorities: ['low'] },
    });
    expect(ruleOnSales.body.error.fields.task_count_rule).toEqual(['invalid']);
  });

  it('rejects a zero, negative, numeric or over-precise target (DOCUMENT 14: zero divides by zero)', async () => {
    const admin = await api(ADMIN_A);
    for (const target_value of ['0', '0.00', '-5', 100, '12.345', 'abc']) {
      const response = await admin.post('/goals').send({
        employee_id: workerEmployeeId,
        type: 'sales',
        title: 'Bad target',
        unit: 'EGP',
        target_value,
        period_start: '2026-03-01',
        period_end: '2026-03-31',
      });
      expect(response.status, String(target_value)).toBe(422);
      expect(Object.keys(response.body.error.fields)).toContain('target_value');
    }
  });

  it('rejects a period that does not end after it starts, and dates that do not exist', async () => {
    const admin = await api(ADMIN_A);
    for (const [start, end, field, issue] of [
      ['2026-03-10', '2026-03-10', 'period_end', 'end_before_start'],
      ['2026-03-10', '2026-03-01', 'period_end', 'end_before_start'],
      ['2026-02-30', '2026-03-31', 'period_start', 'invalid'],
    ] as const) {
      const response = await admin.post('/goals').send({
        employee_id: workerEmployeeId,
        type: 'sales',
        title: 'Bad period',
        unit: 'EGP',
        target_value: '10',
        period_start: start,
        period_end: end,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.fields[field]).toEqual([issue]);
    }
  });

  it('the owner must be an active employee within the caller’s scope', async () => {
    const inactive = await (await api(ADMIN_A)).post('/goals').send({
      employee_id: inactiveEmployeeId,
      type: 'custom',
      title: 'x',
      unit: 'pts',
      target_value: '1',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    });
    expect(inactive.body.error.fields.employee_id).toEqual(['not_active']);

    const otherCompany = await (await api(ADMIN_A)).post('/goals').send({
      employee_id: workerBId,
      type: 'custom',
      title: 'x',
      unit: 'pts',
      target_value: '1',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    });
    expect(otherCompany.body.error.fields.employee_id).toEqual(['not_found']);

    const outsideTeam = await (await api(MANAGER)).post('/goals').send({
      employee_id: outsiderEmployeeId,
      type: 'custom',
      title: 'x',
      unit: 'pts',
      target_value: '1',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    });
    expect(outsideTeam.body.error.fields.employee_id).toEqual(['not_found']);
  });

  it('never accepts company_id, a status or a current value from the client', async () => {
    const admin = await api(ADMIN_A);
    for (const extra of [
      { company_id: COMPANY_B },
      { status: 'achieved' },
      { current_value: '5' },
    ]) {
      const response = await admin.post('/goals').send({
        employee_id: workerEmployeeId,
        type: 'custom',
        title: 'x',
        unit: 'pts',
        target_value: '1',
        period_start: '2026-03-01',
        period_end: '2026-03-31',
        ...extra,
      });
      expect(response.status).toBe(422);
    }
    expect((await admin.get('/goals').query({ company_id: COMPANY_B })).status).toBe(422);
  });

  it('warns about an overlapping goal of the same type, and allows it (rule 8)', async () => {
    const first = await createGoal({
      employee_id: outsiderEmployeeId,
      type: 'custom',
      unit: 'pts',
      target_value: '10',
    });
    expect(first.warnings).toEqual([]);
    const second = await createGoal({
      employee_id: outsiderEmployeeId,
      type: 'custom',
      unit: 'pts',
      target_value: '10',
      period_start: '2026-03-15',
      period_end: '2026-04-15',
    });
    expect(second.warnings).toEqual(['overlapping_goal']);
    const otherType = await createGoal({ employee_id: outsiderEmployeeId });
    expect(otherType.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Manual progress — DOCUMENT 14 rules 1, 2, 3, 5, 6; FLOW 13
// ---------------------------------------------------------------------------

describe('manual progress — Sales and Custom goals', () => {
  it('reproduces the Sales example, appends history and detects milestones after commit', async () => {
    const goal = await createGoal();
    const response = await progress(goal.id, '75000', ADMIN_A, 'Q1 invoices');
    expect(response.status).toBe(201);
    const body = response.body.data as GoalBody;
    expect(body.current_value).toBe('75000.00');
    expect(body.progress_percent).toBe('75.00');
    expect(body.milestones_crossed).toEqual([25, 50, 75]);
    expect(body.milestones_reached).toEqual([25, 50, 75]);
    expect(sink.events.map((event) => event.milestone)).toEqual([25, 50, 75]);
    expect(sink.events[0]).toMatchObject({
      type: 'goal_milestone',
      companyId: COMPANY_A,
      goalId: goal.id,
      employeeId: workerEmployeeId,
    });

    const rows = await history(goal.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      value: '75000.00',
      previous_value: '0.00',
      target_value: '100000.00',
      progress_percent: '75.00',
      note: 'Q1 invoices',
      source: 'manual',
    });
    const audits = await auditsFor('goal', goal.id, 'GOAL_PROGRESS_UPDATED');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.oldValues).toMatchObject({ current_value: '0.00' });
    expect(audits[0]?.newValues).toMatchObject({
      current_value: '75000.00',
      progress_percent: '75.00',
    });
  });

  it('over-achievement keeps its true value; the display caps at 100%', async () => {
    const goal = await createGoal();
    const response = await progress(goal.id, '112000');
    const body = response.body.data as GoalBody;
    expect(body.progress_percent).toBe('112.00');
    expect(body.progress_display_percent).toBe('100.00');
    expect(body.milestones_crossed).toEqual([25, 50, 75, 100]);
    // Still active until the period ends (rule 7).
    expect(body.status).toBe('active');
  });

  it('reproduces the Custom example: 84% against a 90% target is 93.33% toward it', async () => {
    const goal = await createGoal({ type: 'custom', unit: '%', target_value: '90' });
    const body = (await progress(goal.id, '84')).body.data as GoalBody;
    expect(body.current_value).toBe('84.00');
    expect(body.progress_percent).toBe('93.33');
  });

  it('a correction downward crosses no milestone and is appended, not overwritten', async () => {
    const goal = await createGoal();
    await progress(goal.id, '60000');
    sink.events.length = 0;
    const body = (await progress(goal.id, '40000', ADMIN_A, 'Returned order')).body
      .data as GoalBody;
    expect(body.milestones_crossed).toEqual([]);
    expect(sink.events).toEqual([]);
    const rows = await history(goal.id);
    expect(rows.map((row) => row.value)).toEqual(['40000.00', '60000.00', '0.00']);
    expect(rows[0]?.previous_value).toBe('60000.00');
  });

  it('refuses a negative value, a number, and an overlong note', async () => {
    const goal = await createGoal();
    expect((await progress(goal.id, '-1')).status).toBe(422);
    const numeric = await (await api(ADMIN_A))
      .post(`/goals/${goal.id}/progress`)
      .send({ value: 5 });
    expect(numeric.status).toBe(422);
    expect((await progress(goal.id, '1', ADMIN_A, 'x'.repeat(1001))).status).toBe(422);
  });

  it('a Task goal takes no manual figure (rule 4)', async () => {
    const goal = await createGoal({ type: 'task', target_value: '5', unit: undefined });
    const response = await progress(goal.id, '3');
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('GOAL_PROGRESS_AUTOMATIC');
  });

  it('an employee never edits their own figures; a manager edits only their team’s', async () => {
    const goal = await createGoal();
    expect((await progress(goal.id, '10', WORKER)).status).toBe(403);
    expect((await progress(goal.id, '10', MANAGER)).status).toBe(201);
    const outsiders = await createGoal({ employee_id: outsiderEmployeeId });
    expect((await progress(outsiders.id, '10', MANAGER)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Edit and cancel
// ---------------------------------------------------------------------------

describe('editing — target changes keep the old target in history', () => {
  it('audits the target change and appends a row carrying the new target', async () => {
    const goal = await createGoal();
    await progress(goal.id, '50000');
    sink.events.length = 0;
    const response = await (await api(ADMIN_A))
      .patch(`/goals/${goal.id}`)
      .send({ target_value: '60000' });
    expect(response.status).toBe(200);
    const body = response.body.data as GoalBody;
    expect(body.target_value).toBe('60000.00');
    expect(body.progress_percent).toBe('83.33');
    // Lowering the target carried progress past 75%.
    expect(sink.events.map((event) => event.milestone)).toEqual([75]);

    const rows = await history(goal.id);
    expect(rows.map((row) => row.target_value)).toEqual(['60000.00', '100000.00', '100000.00']);
    expect(rows[1]?.progress_percent).toBe('50.00');
    const audits = await auditsFor('goal', goal.id, 'GOAL_TARGET_CHANGED');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.oldValues).toMatchObject({ target_value: '100000.00' });
    expect(audits[0]?.newValues).toMatchObject({ target_value: '60000.00' });
  });

  it('audits only the fields that changed, and refuses the owner, type and value', async () => {
    const goal = await createGoal();
    const admin = await api(ADMIN_A);
    expect((await admin.patch(`/goals/${goal.id}`).send({ title: 'Renamed' })).status).toBe(200);
    const audits = await auditsFor('goal', goal.id, 'GOAL_UPDATED');
    expect(audits.at(-1)?.newValues).toEqual({ title: 'Renamed' });
    for (const extra of [
      { employee_id: outsiderEmployeeId },
      { type: 'custom' },
      { current_value: '1' },
      { status: 'achieved' },
    ]) {
      expect((await admin.patch(`/goals/${goal.id}`).send(extra)).status).toBe(422);
    }
    const period = await admin.patch(`/goals/${goal.id}`).send({ period_end: '2026-02-01' });
    expect(period.body.error.fields.period_end).toEqual(['end_before_start']);
    expect((await admin.patch(`/goals/${goal.id}`).send({ target_value: '0' })).status).toBe(422);
  });
});

describe('cancelling — DELETE /goals/{id}', () => {
  it('cancels, keeps the goal and its history readable, and refuses every later change', async () => {
    const goal = await createGoal();
    await progress(goal.id, '1000');
    const admin = await api(ADMIN_A);
    expect((await admin.delete(`/goals/${goal.id}`)).status).toBe(204);

    const after = await getGoal(goal.id);
    expect(after.status).toBe('cancelled');
    expect(after.abilities).toEqual({
      can_edit: false,
      can_update_progress: false,
      can_cancel: false,
    });
    expect(await history(goal.id)).toHaveLength(2);
    expect(await auditsFor('goal', goal.id, 'GOAL_CANCELLED')).toHaveLength(1);

    const update = await progress(goal.id, '2000');
    expect(update.status).toBe(422);
    expect(update.body.error.code).toBe('GOAL_CANCELLED');
    const edit = await admin.patch(`/goals/${goal.id}`).send({ title: 'Again' });
    expect(edit.body.error.code).toBe('GOAL_CANCELLED');
    expect((await admin.delete(`/goals/${goal.id}`)).body.error.code).toBe('GOAL_CANCELLED');

    const link = await admin.post('/tasks').send({
      title: 'Linked to a cancelled goal',
      priority: 'medium',
      assignee_employee_id: workerEmployeeId,
      goal_id: goal.id,
    });
    expect(link.body.error.fields.goal_id).toEqual(['cancelled']);
  });
});

// ---------------------------------------------------------------------------
// Task ↔ goal — DOCUMENT 13 rule 8, DOCUMENT 14 rule 4, FLOWS 10 and 13
// ---------------------------------------------------------------------------

describe('Task goals derive their value from linked, completed tasks', () => {
  it('completing raises the goal, reopening lowers it — appended and audited every time', async () => {
    const goal = await createGoal({
      type: 'task',
      title: 'Close two deals',
      target_value: '2',
      unit: undefined,
    });
    const first = await createTask({ goal_id: goal.id, deadline: '2026-03-20' });
    const second = await createTask({ goal_id: goal.id });
    expect(first.warnings).toEqual([]);
    expect((await getGoal(goal.id)).possibly_misconfigured).toBe(false);

    await complete(first.id);
    let now = await getGoal(goal.id);
    expect(now.current_value).toBe('1.00');
    expect(now.progress_percent).toBe('50.00');
    expect(sink.events.map((event) => event.milestone)).toEqual([25, 50]);
    expect(now.linked_tasks.find((task) => task.id === first.id)?.counts).toBe(true);
    expect(now.linked_tasks.find((task) => task.id === second.id)?.counts).toBe(false);

    await complete(second.id);
    now = await getGoal(goal.id);
    expect(now.current_value).toBe('2.00');
    expect(now.progress_percent).toBe('100.00');

    // DOCUMENT 13 edge case: reopening recalculates downward, and is audited.
    expect((await setStatus(first.id, 'in_progress', { reason: 'Client withdrew' })).status).toBe(
      200,
    );
    now = await getGoal(goal.id);
    expect(now.current_value).toBe('1.00');

    const rows = await history(goal.id);
    expect(rows.map((row) => row.value)).toEqual(['1.00', '2.00', '1.00', '0.00']);
    expect(rows.slice(0, 3).every((row) => row.source === 'system')).toBe(true);
    const audits = await auditsFor('goal', goal.id, 'GOAL_PROGRESS_UPDATED');
    expect(audits).toHaveLength(3);
    expect(audits.at(-1)?.oldValues).toMatchObject({ current_value: '2.00' });
    expect(audits.at(-1)?.newValues).toMatchObject({ current_value: '1.00', source: 'system' });

    const filtered = await (await api(ADMIN_A)).get('/tasks').query({ goal_id: goal.id });
    expect(filtered.body.meta.total).toBe(2);
    const task = await (await api(ADMIN_A)).get(`/tasks/${first.id}`);
    expect(task.body.data.goal).toMatchObject({ id: goal.id, type: 'task' });
  });

  it('deleting a completed linked task removes it from the count', async () => {
    const goal = await createGoal({ type: 'task', target_value: '4', unit: undefined });
    const task = await createTask({ goal_id: goal.id });
    await complete(task.id);
    expect((await getGoal(goal.id)).current_value).toBe('1.00');
    expect((await (await api(ADMIN_A)).delete(`/tasks/${task.id}`)).status).toBe(204);
    expect((await getGoal(goal.id)).current_value).toBe('0.00');
  });

  it('counts only the priorities its rule names; re-prioritising a completed task recalculates', async () => {
    const goal = await createGoal({
      type: 'task',
      target_value: '4',
      unit: undefined,
      task_count_rule: { version: 1, priorities: ['high', 'urgent'] },
    });
    const task = await createTask({ goal_id: goal.id, priority: 'low' });
    expect((await getGoal(goal.id)).possibly_misconfigured).toBe(true);
    await complete(task.id);
    expect((await getGoal(goal.id)).current_value).toBe('0.00');
    expect(
      (await (await api(ADMIN_A)).patch(`/tasks/${task.id}`).send({ priority: 'high' })).status,
    ).toBe(200);
    const now = await getGoal(goal.id);
    expect(now.current_value).toBe('1.00');
    expect(now.possibly_misconfigured).toBe(false);
  });

  it('the approved V1 rule: no priority selected counts all; only the owner’s tasks count', async () => {
    const goal = await createGoal({
      type: 'task',
      target_value: '3',
      unit: undefined,
      task_count_rule: { version: 1, priorities: [] },
    });
    // No priority selected is stored as all four, so the stored rule is explicit.
    expect(goal.task_count_rule).toEqual({
      version: 1,
      priorities: ['low', 'medium', 'high', 'urgent'],
    });
    const low = await createTask({ goal_id: goal.id, priority: 'low' });
    await complete(low.id);
    expect((await getGoal(goal.id)).current_value).toBe('1.00');

    // Linking cannot produce a task owned by someone else (the validation
    // test below), so the row is moved directly: the count must not rest on
    // that validation alone.
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.task.update({ where: { id: low.id }, data: { assigneeEmployeeId: outsiderEmployeeId } }),
    );
    expect((await getGoal(goal.id)).linked_tasks.find((t) => t.id === low.id)?.counts).toBe(false);
    const urgent = await createTask({ goal_id: goal.id, priority: 'urgent' });
    await complete(urgent.id);
    const now = await getGoal(goal.id);
    expect(now.current_value).toBe('1.00');
    expect(now.linked_tasks.find((t) => t.id === urgent.id)?.counts).toBe(true);
  });

  it('relinking moves the count from one goal to the other; unlinking removes it', async () => {
    const a = await createGoal({ type: 'task', target_value: '4', unit: undefined });
    const b = await createGoal({ type: 'task', target_value: '4', unit: undefined });
    const task = await createTask({ goal_id: a.id });
    await complete(task.id);
    const admin = await api(ADMIN_A);
    expect((await admin.patch(`/tasks/${task.id}`).send({ goal_id: b.id })).status).toBe(200);
    expect((await getGoal(a.id)).current_value).toBe('0.00');
    expect((await getGoal(b.id)).current_value).toBe('1.00');
    expect((await admin.patch(`/tasks/${task.id}`).send({ goal_id: null })).status).toBe(200);
    expect((await getGoal(b.id)).current_value).toBe('0.00');
  });

  it('a task completed outside the goal’s period does not count, and linking warns', async () => {
    const past = await createGoal({
      type: 'task',
      target_value: '1',
      unit: undefined,
      period_start: '2026-02-01',
      period_end: '2026-02-28',
    });
    // Created after its period ended: closed at once, as rule 7 says.
    expect(past.status).toBe('missed');
    const task = await createTask({ goal_id: past.id });
    expect(task.warnings).toEqual(['goal_outside_period']);
    await complete(task.id);
    expect((await getGoal(past.id)).current_value).toBe('0.00');

    const current = await createGoal({ type: 'task', target_value: '1', unit: undefined });
    const late = await createTask({ goal_id: current.id, deadline: '2026-04-15' });
    expect(late.warnings).toEqual(['goal_outside_period']);
  });

  it('the linked goal must belong to the assignee, in this company (DOCUMENT 13 validation)', async () => {
    const outsiders = await createGoal({
      employee_id: outsiderEmployeeId,
      type: 'task',
      target_value: '1',
      unit: undefined,
    });
    const admin = await api(ADMIN_A);
    const mismatch = await admin.post('/tasks').send({
      title: 'Wrong owner',
      priority: 'medium',
      assignee_employee_id: workerEmployeeId,
      goal_id: outsiders.id,
    });
    expect(mismatch.body.error.fields.goal_id).toEqual(['not_same_employee']);

    const bGoal = await createGoal(
      { employee_id: workerBId, type: 'custom', unit: 'pts', target_value: '1' },
      ADMIN_B,
    );
    const foreign = await admin.post('/tasks').send({
      title: 'Foreign goal',
      priority: 'medium',
      assignee_employee_id: workerEmployeeId,
      goal_id: bGoal.id,
    });
    expect(foreign.body.error.fields.goal_id).toEqual(['not_found']);

    // Reassigning a linked task needs the link changed too.
    const mine = await createGoal({ type: 'task', target_value: '1', unit: undefined });
    const task = await createTask({ goal_id: mine.id });
    const reassign = await admin
      .patch(`/tasks/${task.id}`)
      .send({ assignee_employee_id: outsiderEmployeeId });
    expect(reassign.body.error.fields.goal_id).toEqual(['not_same_employee']);
    const both = await admin
      .patch(`/tasks/${task.id}`)
      .send({ assignee_employee_id: outsiderEmployeeId, goal_id: outsiders.id });
    expect(both.status).toBe(200);
  });

  it('recalculation is atomic with the task change: a failed goal write rolls the task back', async () => {
    const goal = await createGoal({ type: 'task', target_value: '2', unit: undefined });
    const task = await createTask({ goal_id: goal.id });
    expect((await setStatus(task.id, 'in_progress')).status).toBe(200);

    await prisma.$executeRawUnsafe('RESET ROLE');
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_force_goal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.goal_id = '${goal.id}'::uuid THEN
          RAISE EXCEPTION 'forced failure';
        END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_force_goal_failure BEFORE INSERT ON goal_progress FOR EACH ROW EXECUTE FUNCTION test_force_goal_failure()',
    );
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    try {
      const response = await setStatus(task.id, 'completed');
      expect(response.status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe('RESET ROLE');
      await prisma.$executeRawUnsafe('DROP TRIGGER test_force_goal_failure ON goal_progress');
      await prisma.$executeRawUnsafe('DROP FUNCTION test_force_goal_failure()');
      await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    }
    const after = await (await api(ADMIN_A)).get(`/tasks/${task.id}`);
    expect(after.body.data.status).toBe('in_progress');
    expect((await getGoal(goal.id)).current_value).toBe('0.00');
    // No milestone is published for a rolled-back change (DOCUMENT 19 rule 2).
    expect(sink.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Period end — DOCUMENT 14 rule 7
// ---------------------------------------------------------------------------

describe('period end — achieved or missed, automatically', () => {
  /** 1 April 2026, 10:00 in Cairo. */
  const APRIL_FIRST = new Date(Date.UTC(2026, 3, 1, 8, 0, 0));

  it('closes ended goals by progress, audits as the system actor, and is idempotent', async () => {
    const reached = await createGoal({
      employee_id: perfEmployeeId,
      type: 'custom',
      unit: 'pts',
      target_value: '10',
    });
    const short = await createGoal({
      employee_id: perfEmployeeId,
      type: 'custom',
      unit: 'pts',
      target_value: '10',
    });
    const later = await createGoal({
      employee_id: perfEmployeeId,
      type: 'custom',
      unit: 'pts',
      target_value: '10',
      period_end: '2026-04-30',
    });
    await progress(reached.id, '10');
    await progress(short.id, '9.99');

    const lifecycle = app.get(GoalLifecycleService);
    const result = await lifecycle.closeEnded(COMPANY_A, APRIL_FIRST);
    expect(result.achieved).toBeGreaterThanOrEqual(1);
    expect(result.missed).toBeGreaterThanOrEqual(1);
    expect((await getGoal(reached.id)).status).toBe('achieved');
    expect((await getGoal(short.id)).status).toBe('missed');
    expect((await getGoal(later.id)).status).toBe('active');

    const audit = (await auditsFor('goal', reached.id, 'GOAL_UPDATED')).at(-1);
    expect(audit?.newValues).toMatchObject({ status: 'achieved' });
    const actor = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: audit?.userId as string } }),
    );
    expect(actor.isSystem).toBe(true);

    expect(await lifecycle.closeEnded(COMPANY_A, APRIL_FIRST)).toEqual({ achieved: 0, missed: 0 });
  });

  it('recalculating or reopening a closed goal re-derives its status and keeps its history', async () => {
    const goal = await createGoal({
      type: 'custom',
      unit: 'pts',
      target_value: '10',
      period_start: '2026-02-01',
      period_end: '2026-02-28',
    });
    expect(goal.status).toBe('missed');
    // A late figure turns missed into achieved.
    const late = (await progress(goal.id, '10')).body.data as GoalBody;
    expect(late.status).toBe('achieved');
    // Extending the period reopens it.
    const reopened = await (await api(ADMIN_A))
      .patch(`/goals/${goal.id}`)
      .send({ period_end: '2026-03-31' });
    expect(reopened.body.data.status).toBe('active');
    expect(await history(goal.id)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Permissions, scope and tenancy — DOCUMENT 02 "Goals", DOCUMENT 09 §4
// ---------------------------------------------------------------------------

describe('permission matrix and scope', () => {
  it('lists: admin the company, manager the team, employee their own, company B nothing of A', async () => {
    const workerGoal = await createGoal();
    const outsiderGoal = await createGoal({ employee_id: outsiderEmployeeId });

    const ids = async (account: Account) =>
      (
        (await (await api(account)).get('/goals').query({ per_page: 100 })).body.data as GoalBody[]
      ).map((goal) => goal.id);
    expect(await ids(ADMIN_A)).toEqual(expect.arrayContaining([workerGoal.id, outsiderGoal.id]));
    const manager = await ids(MANAGER);
    expect(manager).toContain(workerGoal.id);
    expect(manager).not.toContain(outsiderGoal.id);
    const worker = await ids(WORKER);
    expect(worker).toContain(workerGoal.id);
    expect(worker).not.toContain(outsiderGoal.id);
    expect(await ids(ADMIN_B)).not.toContain(workerGoal.id);

    const filtered = await (await api(ADMIN_A))
      .get('/goals')
      .query({ employee_id: outsiderEmployeeId, per_page: 100 });
    expect((filtered.body.data as GoalBody[]).every((goal) => goal.id !== workerGoal.id)).toBe(
      true,
    );
  });

  it('reads: another company’s goal is 404; an in-tenant goal outside scope is 403', async () => {
    const goal = await createGoal();
    expect((await (await api(ADMIN_B)).get(`/goals/${goal.id}`)).status).toBe(404);
    expect((await (await api(ADMIN_B)).get(`/goals/${goal.id}/progress`)).status).toBe(404);
    expect((await (await api(OUTSIDER)).get(`/goals/${goal.id}`)).status).toBe(403);
    const own = await getGoal(goal.id, WORKER);
    expect(own.abilities).toEqual({
      can_edit: false,
      can_update_progress: false,
      can_cancel: false,
    });
    expect((await (await api(MANAGER)).get(`/goals/${goal.id}`)).status).toBe(200);
  });

  it('writes: an employee can create, edit, cancel and update nothing', async () => {
    const goal = await createGoal();
    const worker = await api(WORKER);
    expect(
      (
        await worker.post('/goals').send({
          employee_id: workerEmployeeId,
          type: 'custom',
          title: 'Self-set',
          unit: 'pts',
          target_value: '1',
          period_start: '2026-03-01',
          period_end: '2026-03-31',
        })
      ).status,
    ).toBe(403);
    expect((await worker.patch(`/goals/${goal.id}`).send({ title: 'Mine' })).status).toBe(403);
    expect((await worker.delete(`/goals/${goal.id}`)).status).toBe(403);
    expect((await progress(goal.id, '1', WORKER)).status).toBe(403);
  });

  it('a manager edits their team’s goals and not anyone else’s; company B cannot touch A', async () => {
    const team = await createGoal();
    const other = await createGoal({ employee_id: outsiderEmployeeId });
    const manager = await api(MANAGER);
    expect((await manager.patch(`/goals/${team.id}`).send({ title: 'Team' })).status).toBe(200);
    expect((await manager.patch(`/goals/${other.id}`).send({ title: 'Not mine' })).status).toBe(
      403,
    );
    expect((await manager.delete(`/goals/${other.id}`)).status).toBe(403);
    const created = await createGoal({ type: 'custom', unit: 'pts', target_value: '3' }, MANAGER);
    expect(created.status).toBe('active');

    const adminB = await api(ADMIN_B);
    expect((await adminB.patch(`/goals/${team.id}`).send({ title: 'B' })).status).toBe(404);
    expect((await adminB.delete(`/goals/${team.id}`)).status).toBe(404);
    expect((await progress(team.id, '1', ADMIN_B)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Performance configuration — DOCUMENT 14 "Validation", DOCUMENT 08 §4.2
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  weights: { attendance: '0.3000', task: '0.4000', goal: '0.3000' },
  attendance: { late_penalty: '1.00', absence_penalty: '5.00' },
  task: { completion_weight: '0.6000', on_time_weight: '0.4000' },
};

describe('performance configuration', () => {
  it('every company starts with DOCUMENT 14’s default model, as data', async () => {
    const response = await (await api(ADMIN_A)).get('/performance-config');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      schema_version: 1,
      ...DEFAULT_CONFIG,
      updated_by: null,
    });
  });

  it('only an administrator reads (settings.view) and writes (settings.performance_weights) it', async () => {
    expect((await (await api(MANAGER)).get('/performance-config')).status).toBe(403);
    expect((await (await api(WORKER)).get('/performance-config')).status).toBe(403);
    expect(
      (await (await api(MANAGER)).patch('/performance-config').send(DEFAULT_CONFIG)).status,
    ).toBe(403);
  });

  it('refuses weights that do not sum to exactly 1.0, naming each problem', async () => {
    const admin = await api(ADMIN_A);
    const sum = await admin
      .patch('/performance-config')
      .send({ ...DEFAULT_CONFIG, weights: { attendance: '0.3', task: '0.4', goal: '0.4' } });
    expect(sum.status).toBe(422);
    expect(sum.body.error.fields.weights).toEqual(['must_sum_to_one']);

    const range = await admin
      .patch('/performance-config')
      .send({ ...DEFAULT_CONFIG, weights: { attendance: '1.5', task: '-0.5', goal: '0' } });
    expect(range.body.error.fields['weights.attendance']).toEqual(['invalid']);
    expect(range.body.error.fields['weights.task']).toEqual(['invalid']);

    const sub = await admin
      .patch('/performance-config')
      .send({ ...DEFAULT_CONFIG, task: { completion_weight: '0.5', on_time_weight: '0.4' } });
    expect(sub.body.error.fields.task).toEqual(['must_sum_to_one']);

    const missing = await admin
      .patch('/performance-config')
      .send({ weights: DEFAULT_CONFIG.weights });
    expect(missing.body.error.fields.attendance).toEqual(['required']);

    const numbers = await admin
      .patch('/performance-config')
      .send({ ...DEFAULT_CONFIG, attendance: { late_penalty: 1, absence_penalty: '5' } });
    expect(numbers.body.error.fields['attendance.late_penalty']).toEqual(['invalid']);

    expect(
      (await admin.patch('/performance-config').send({ ...DEFAULT_CONFIG, company_id: COMPANY_B }))
        .status,
    ).toBe(422);
  });

  it('saves, audits only what changed, and leaves another company’s model alone', async () => {
    const admin = await api(ADMIN_A);
    const saved = await admin
      .patch('/performance-config')
      .send({ ...DEFAULT_CONFIG, attendance: { late_penalty: '2', absence_penalty: '5' } });
    expect(saved.status).toBe(200);
    expect(saved.body.data.attendance.late_penalty).toBe('2.00');
    expect(saved.body.data.updated_by).not.toBeNull();

    const audits = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { action: 'SETTINGS_PERFORMANCE_WEIGHTS_CHANGED' } }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.entityType).toBe('performance_config');
    expect(audits[0]?.oldValues).toEqual({ 'attendance.late_penalty': '1.00' });
    expect(audits[0]?.newValues).toEqual({ 'attendance.late_penalty': '2.00' });

    const b = await (await api(ADMIN_B)).get('/performance-config');
    expect(b.body.data.attendance.late_penalty).toBe('1.00');

    // Restore the default for the scoring tests below.
    expect((await admin.patch('/performance-config').send(DEFAULT_CONFIG)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Employee performance — DOCUMENT 14, DOCUMENT 25 Phase 8 exit criterion
// ---------------------------------------------------------------------------

interface PerformanceBody {
  readonly month: string;
  readonly is_provisional: boolean;
  readonly overall: string | null;
  readonly config: { weights: Record<string, string> };
  readonly components: {
    readonly attendance: {
      score: string | null;
      effective_weight: string | null;
      no_data_reason: string | null;
      inputs: Record<string, number | string | null> | null;
    };
    readonly task: {
      score: string | null;
      completion_rate: string | null;
      on_time_rate: string | null;
      inputs: Record<string, number>;
    };
    readonly goal: { score: string | null; goals: { progress_percent: string }[] };
  };
}

describe('employee performance — computed entirely from configuration', () => {
  beforeAll(async () => {
    // Attendance, 1–9 March (yesterday is the 9th). Sun–Thu working: the 1st,
    // 2nd, 3rd, 4th, 5th, 8th and 9th — seven scheduled working days.
    const days: [string, string, 'office' | 'wfh' | null][] = [
      ['2026-03-01', 'present', 'office'],
      ['2026-03-02', 'present', 'office'],
      ['2026-03-03', 'present', 'wfh'],
      ['2026-03-04', 'late', 'office'],
      ['2026-03-05', 'present', 'office'],
      ['2026-03-06', 'weekend', null],
      ['2026-03-08', 'absent', null],
      ['2026-03-09', 'present', 'office'],
    ];
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.createMany({
        data: days.map(([date, status, workMode]) => ({
          id: generateId(),
          companyId: COMPANY_A,
          employeeId: perfEmployeeId,
          date: new Date(`${date}T00:00:00.000Z`),
          status: status as never,
          workMode,
          source: 'admin' as const,
        })),
      }),
    );

    // Tasks due in March: one done on time, one done late, one open, and one
    // cancelled (excluded).
    const onTime = await createTask({
      assignee_employee_id: perfEmployeeId,
      deadline: '2026-03-12',
    });
    const lateTask = await createTask({
      assignee_employee_id: perfEmployeeId,
      deadline: '2026-03-05',
    });
    await createTask({ assignee_employee_id: perfEmployeeId, deadline: '2026-03-25' });
    const cancelled = await createTask({
      assignee_employee_id: perfEmployeeId,
      deadline: '2026-03-25',
    });
    await complete(onTime.id);
    await complete(lateTask.id);
    expect((await setStatus(cancelled.id, 'cancelled', { reason: 'Not needed' })).status).toBe(200);
  });

  async function performance(employeeId: string, account: Account = ADMIN_A, month?: string) {
    return (await api(account))
      .get(`/employees/${employeeId}/performance`)
      .query(month === undefined ? {} : { month });
  }

  it('scores the month with the default configuration', async () => {
    // Goals for the month: 82% and 90% (DOCUMENT 14's worked example).
    const sales = await createGoal({
      employee_id: perfEmployeeId,
      period_end: '2026-03-31',
      target_value: '100000',
    });
    await progress(sales.id, '82000');
    const custom = await createGoal({
      employee_id: perfEmployeeId,
      type: 'custom',
      unit: '%',
      target_value: '100',
    });
    await progress(custom.id, '90');

    const response = await performance(perfEmployeeId);
    expect(response.status).toBe(200);
    const body = response.body.data as PerformanceBody;
    expect(body.month).toBe('2026-03');
    expect(body.is_provisional).toBe(true);
    expect(body.components.attendance.inputs).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-09',
      working_days: 7,
      present_days: 5,
      wfh_days: 1,
      paid_leave_days: 0,
      late_incidents: 1,
      absent_days: 1,
    });
    // 6 ÷ 7 = 85.714286%, − 1 × 1.00 − 1 × 5.00
    expect(body.components.attendance.score).toBe('79.71');
    expect(body.components.task.inputs).toEqual({
      assigned: 3,
      completed: 2,
      completed_on_time: 1,
    });
    expect(body.components.task.completion_rate).toBe('66.67');
    expect(body.components.task.on_time_rate).toBe('50.00');
    // 66.666667 × 0.6 + 50 × 0.4
    expect(body.components.task.score).toBe('60.00');

    // The period-end test's two goals for this employee also fall in March
    // (100% and 99.9%); every goal in the month is averaged, each capped.
    const percents = body.components.goal.goals.map((goal) => goal.progress_percent);
    expect(percents).toEqual(expect.arrayContaining(['82.00', '90.00']));
    const capped = percents.map((p) => Math.min(Number(p), 100));
    const average = capped.reduce((a, b) => a + b, 0) / capped.length;
    expect(Number(body.components.goal.score)).toBeCloseTo(average, 2);

    const expected = 0.3 * 79.714286 + 0.4 * 60 + 0.3 * Number(body.components.goal.score);
    expect(Number(body.overall)).toBeCloseTo(expected, 1);
  });

  it('a different saved configuration gives exactly the number that configuration implies', async () => {
    const admin = await api(ADMIN_A);
    expect(
      (
        await admin.patch('/performance-config').send({
          weights: { attendance: '1', task: '0', goal: '0' },
          attendance: { late_penalty: '0', absence_penalty: '0' },
          task: { completion_weight: '1', on_time_weight: '0' },
        })
      ).status,
    ).toBe(200);
    let body = (await performance(perfEmployeeId)).body.data as PerformanceBody;
    // 6 ÷ 7 with no penalties, and attendance alone weighted.
    expect(body.components.attendance.score).toBe('85.71');
    expect(body.components.task.score).toBe('66.67');
    expect(body.overall).toBe('85.71');
    expect(body.config.weights).toEqual({ attendance: '1.0000', task: '0.0000', goal: '0.0000' });

    expect(
      (
        await admin.patch('/performance-config').send({
          weights: { attendance: '0', task: '1', goal: '0' },
          attendance: DEFAULT_CONFIG.attendance,
          task: { completion_weight: '0', on_time_weight: '1' },
        })
      ).status,
    ).toBe(200);
    body = (await performance(perfEmployeeId)).body.data as PerformanceBody;
    expect(body.overall).toBe('50.00');

    expect((await admin.patch('/performance-config').send(DEFAULT_CONFIG)).status).toBe(200);
  });

  it('no data is "no data" — null, never an artificial 0%', async () => {
    // Joined today: no ended working day, no tasks, no goals.
    const body = (await performance(newcomerEmployeeId)).body.data as PerformanceBody;
    expect(body.overall).toBeNull();
    expect(body.components.attendance.score).toBeNull();
    expect(body.components.attendance.no_data_reason).toBe('no_working_days');
    expect(body.components.attendance.effective_weight).toBeNull();
    expect(body.components.task.score).toBeNull();
    expect(body.components.goal.score).toBeNull();

    // A past month with no records at all is also no data.
    const february = (await performance(perfEmployeeId, ADMIN_A, '2026-02')).body
      .data as PerformanceBody;
    expect(february.is_provisional).toBe(false);
    expect(february.components.attendance.no_data_reason).toBe('no_records');
    expect(february.components.attendance.score).toBeNull();
    expect(february.overall).toBeNull();
  });

  it('missing components are excluded and the remaining weights renormalised', async () => {
    // The worker has tasks and goals in March but no attendance records.
    const body = (await performance(workerEmployeeId)).body.data as PerformanceBody;
    expect(body.components.attendance.score).toBeNull();
    expect(body.components.attendance.effective_weight).toBeNull();
    expect(body.overall).not.toBeNull();
  });

  it('validates the month and enforces scope', async () => {
    expect((await performance(perfEmployeeId, ADMIN_A, '2026-13')).status).toBe(422);
    expect((await performance(perfEmployeeId, ADMIN_A, '2026-04')).status).toBe(422);
    expect((await performance(perfEmployeeId, MANAGER)).status).toBe(200);
    expect((await performance(outsiderEmployeeId, MANAGER)).status).toBe(403);
    expect((await performance(workerEmployeeId, WORKER)).status).toBe(200);
    expect((await performance(perfEmployeeId, WORKER)).status).toBe(403);
    expect((await performance(perfEmployeeId, ADMIN_B)).status).toBe(404);
  });
});
