/**
 * Phase 12 at DOCUMENT 26's realistic volume — "reports under 5s or converted
 * to a background job · no N+1 queries on any list or detail endpoint
 * (asserted by query-count tests)".
 *
 * The data set is DOCUMENT 26's: 200 employees, 24 months of attendance
 * (~146,000 records), 10,000 tasks, 5,000 products and 200,000 stock
 * movements, plus 1,000 goals and twelve months of payroll. It is bulk-loaded
 * with `generate_series` as the table owner, with the write triggers paused
 * for the load only — those triggers guard *writes*; every report here is a
 * read, made afterwards through the real API under `ufuq_app` and RLS.
 *
 * Asserted:
 *   - every report answers in under 5 seconds over its widest unconfirmed
 *     range (12 months), with the time logged;
 *   - the number of SQL statements a report issues does not grow with the
 *     number of employees it covers (20 vs 200) — no N+1;
 *   - the full 200,000-movement ledger exports through the background path,
 *     in keyset batches, and the file holds every row.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, PrismaClient, withPlatformContext, withTenant } from '@ufuq/db';
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

import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
import { allMigrationsSql } from './all-migrations.js';

const EMPLOYEES = 200;
const TASKS = 10_000;
const PRODUCTS = 5_000;
const MOVEMENTS_PER_PRODUCT = 40; // 200,000 movements
const GOALS_PER_EMPLOYEE = 5;
const TARGET_MS = 5_000;

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let prisma: PrismaClient;
let queries = 0;

const redis = new FakeRedis();
const storage = new InMemoryObjectStorage();

class NullMail implements MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
}

const COMPANY = generateId();
const ADMIN = { email: 'admin@scale.test', password: 'scale-admin-password-2026' };
const NOW = new Date(Date.UTC(2026, 4, 10, 8, 0, 0));
const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
let adminUser = '';
let token = '';
let smallDepartment = '';
const timings: string[] = [];

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

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

function get(path: string) {
  return request(server()).get(`/${API_PREFIX}${path}`).set('Authorization', `Bearer ${token}`);
}

async function seedAccess(): Promise<void> {
  const roleIdByKey = new Map<string, string>();
  const permissionIdByKey = new Map<string, string>();
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
  const passwordHash = await hashPassword(ADMIN.password);
  await withTenant(prisma, COMPANY, async (tx) => {
    await tx.company.create({
      data: { id: COMPANY, name: 'Scale', slug: 'scale', timezone: 'Africa/Cairo' },
    });
    adminUser = (
      await tx.user.create({
        data: {
          id: generateId(),
          companyId: COMPANY,
          email: ADMIN.email,
          passwordHash,
          roleId: roleIdByKey.get('admin') as string,
          status: 'active',
        },
      })
    ).id;
  });
}

/** The bulk load — one SQL statement per table, as the owner, triggers paused. */
async function bulkLoad(): Promise<void> {
  const c = `'${COMPANY}'::uuid`;
  const u = `'${adminUser}'::uuid`;
  const tables = [
    'employees',
    'attendance_records',
    'tasks',
    'goals',
    'goal_progress',
    'products',
    'warehouses',
    'stock_movements',
    'product_stock',
    'payroll_periods',
    'payroll_lines',
  ];
  await pglite.exec(`SELECT set_config('app.company_id', '${COMPANY}', false);`);
  for (const table of tables) await pglite.exec(`ALTER TABLE "${table}" DISABLE TRIGGER USER;`);
  await pglite.exec(`
    INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, is_default, updated_at)
      VALUES ('00000000-0000-7000-8000-00000000aaaa', ${c}, 'Week', 'Africa/Cairo', 4.00, true, now());
    INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, start_time, end_time, updated_at)
      SELECT gen_random_uuid(), '00000000-0000-7000-8000-00000000aaaa', d, d <= 4,
             CASE WHEN d <= 4 THEN TIME '09:00' END, CASE WHEN d <= 4 THEN TIME '17:00' END, now()
        FROM generate_series(0, 6) d;
    INSERT INTO departments (id, company_id, name_ar, name_en, updated_at)
      SELECT ('00000000-0000-7000-8000-0000000d' || lpad(i::text, 4, '0'))::uuid, ${c}, 'قسم ' || i, 'Dept ' || i, now()
        FROM generate_series(1, 10) i;
    INSERT INTO employees (id, company_id, employee_code, first_name, last_name, department_id, work_schedule_id, joining_date, updated_at)
      SELECT ('00000000-0000-7000-8000-0000000e' || lpad(i::text, 4, '0'))::uuid, ${c}, 'E-' || i, 'First' || i, 'Last' || i,
             ('00000000-0000-7000-8000-0000000d' || lpad((CASE WHEN i <= 20 THEN 1 ELSE 2 + (i % 9) END)::text, 4, '0'))::uuid,
             '00000000-0000-7000-8000-00000000aaaa', DATE '2024-01-01', now()
        FROM generate_series(1, ${String(EMPLOYEES)}) i;
    INSERT INTO attendance_records (id, company_id, employee_id, date, status, source, work_mode, working_minutes, late_minutes, updated_at)
      SELECT gen_random_uuid(), ${c}, e.id, d::date,
             (CASE WHEN extract(dow FROM d) IN (5, 6) THEN 'weekend'
                   WHEN (extract(doy FROM d)::int + e.n) % 23 = 0 THEN 'absent'
                   WHEN (extract(doy FROM d)::int + e.n) % 11 = 0 THEN 'late'
                   ELSE 'present' END)::attendance_status,
             'system',
             (CASE WHEN extract(dow FROM d) IN (5, 6) OR (extract(doy FROM d)::int + e.n) % 23 = 0 THEN NULL
                   WHEN (extract(doy FROM d)::int + e.n) % 4 = 0 THEN 'wfh' ELSE 'office' END)::work_mode,
             420, 0, now()
        FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM employees) e
        CROSS JOIN generate_series(DATE '2024-05-01', DATE '2026-04-30', INTERVAL '1 day') d;
    INSERT INTO tasks (id, company_id, title, assignee_employee_id, priority, status, deadline, completed_at, cancelled_reason, created_by, created_at, updated_at)
      SELECT gen_random_uuid(), ${c}, 'Task ' || i,
             ('00000000-0000-7000-8000-0000000e' || lpad((1 + i % ${String(EMPLOYEES)})::text, 4, '0'))::uuid,
             (ARRAY['low','medium','high','urgent'])[1 + i % 4]::task_priority,
             (ARRAY['not_started','in_progress','completed','completed','on_hold','cancelled'])[1 + i % 6]::task_status,
             DATE '2025-05-01' + (i % 365),
             CASE WHEN (i % 6) IN (2, 3) THEN (DATE '2025-05-01' + (i % 365))::timestamptz + interval '10 hours' END,
             CASE WHEN i % 6 = 5 THEN 'Dropped' END,
             ${u}, TIMESTAMPTZ '2025-04-01 08:00+00', now()
        FROM generate_series(1, ${String(TASKS)}) i;
    INSERT INTO goals (id, company_id, employee_id, type, title, target_value, current_value, unit, period_start, period_end, status, created_by, created_at, updated_at)
      SELECT ('00000000-0000-7000-8000-' || lpad(to_hex(i), 12, '0'))::uuid, ${c},
             ('00000000-0000-7000-8000-0000000e' || lpad((1 + i % ${String(EMPLOYEES)})::text, 4, '0'))::uuid,
             'custom', 'Goal ' || i, 100, i % 120, 'items',
             DATE '2025-05-01' + ((i % 12) * 30), DATE '2025-05-01' + ((i % 12) * 30) + 29,
             (ARRAY['active','achieved','missed'])[1 + i % 3]::goal_status, ${u}, TIMESTAMPTZ '2025-04-01 08:00+00', now()
        FROM generate_series(1, ${String(EMPLOYEES * GOALS_PER_EMPLOYEE)}) i;
    INSERT INTO goal_progress (id, goal_id, value, target_value, source, created_by, created_at)
      SELECT gen_random_uuid(), g.id, g.current_value, g.target_value, 'manual', ${u}, g.period_start::timestamptz + interval '5 days'
        FROM goals g;
    INSERT INTO warehouses (id, company_id, name_ar, name_en, type)
      SELECT ('00000000-0000-7000-8000-0000000f' || lpad(i::text, 4, '0'))::uuid, ${c}, 'موقع ' || i, 'Location ' || i,
             (ARRAY['main','branch','store','production','online'])[i]::warehouse_type
        FROM generate_series(1, 5) i;
    INSERT INTO products (id, company_id, name_ar, name_en, sku, unit, min_stock, cost_price, selling_price)
      SELECT ('00000000-0000-7000-8001-' || lpad(to_hex(i), 12, '0'))::uuid, ${c}, 'منتج ' || i, 'Product ' || i, 'SKU-' || i, 'piece',
             CASE WHEN i % 7 = 0 THEN 150 ELSE 10 END, 10, 20
        FROM generate_series(1, ${String(PRODUCTS)}) i;
    INSERT INTO stock_movements (id, company_id, product_id, warehouse_id, type, quantity, unit_cost, balance_after, created_by, created_at)
      SELECT gen_random_uuid(), ${c},
             ('00000000-0000-7000-8001-' || lpad(to_hex(p), 12, '0'))::uuid,
             ('00000000-0000-7000-8000-0000000f' || lpad((1 + p % 5)::text, 4, '0'))::uuid,
             (CASE WHEN k = 1 THEN 'manual_addition' WHEN k % 2 = 0 THEN 'sale' ELSE 'purchase' END)::stock_movement_type,
             CASE WHEN k = 1 THEN 100 WHEN k % 2 = 0 THEN -1 ELSE 1 END,
             10,
             100 + ((k - 1) / 2) - (k / 2),
             ${u},
             TIMESTAMPTZ '2024-05-01 08:00+00' + (((p * ${String(MOVEMENTS_PER_PRODUCT)} + k) % 730) || ' days')::interval
        FROM generate_series(1, ${String(PRODUCTS)}) p
        CROSS JOIN generate_series(1, ${String(MOVEMENTS_PER_PRODUCT)}) k
       ORDER BY p, k;
    INSERT INTO product_stock (id, company_id, product_id, warehouse_id, quantity, average_cost)
      SELECT gen_random_uuid(), ${c}, m.product_id, m.warehouse_id, SUM(m.quantity), 10
        FROM stock_movements m GROUP BY m.product_id, m.warehouse_id;
    INSERT INTO payroll_periods (id, company_id, year, month, start_date, end_date, status, generated_by, generated_at)
      SELECT ('00000000-0000-7000-8002-' || lpad(i::text, 12, '0'))::uuid, ${c},
             extract(year FROM DATE '2025-05-01' + (i || ' months')::interval)::int,
             extract(month FROM DATE '2025-05-01' + (i || ' months')::interval)::int,
             (DATE '2025-05-01' + (i || ' months')::interval)::date,
             (DATE '2025-05-01' + ((i + 1) || ' months')::interval - interval '1 day')::date,
             'draft', ${u}, now()
        FROM generate_series(0, 11) i;
    INSERT INTO payroll_lines (id, payroll_period_id, company_id, employee_id, base_salary, daily_wage, working_days, present_days,
                               wfh_days, absent_days, paid_leave_days, unpaid_leave_days, late_minutes_total,
                               attendance_adjustment, net_salary, snapshot)
      SELECT gen_random_uuid(), pp.id, ${c}, e.id, 20000, 666.67, 22, 22, 0, 0, 0, 0, 0, 0, 20000, '{}'
        FROM payroll_periods pp CROSS JOIN employees e;
  `);
  for (const table of tables) await pglite.exec(`ALTER TABLE "${table}" ENABLE TRIGGER USER;`);
  smallDepartment = '00000000-0000-7000-8000-0000000d0001';
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
  const url = `postgresql://postgres@127.0.0.1:${String(port)}/postgres?connection_limit=1`;
  // The application's own client, with query events on — to count statements.
  const counted = new PrismaClient({
    datasourceUrl: url,
    log: [{ emit: 'event', level: 'query' }],
  });
  counted.$on('query', (event) => {
    // A bare `SELECT 1` is the engine's own liveness check on a pooled
    // connection that sat idle — not a statement the request issued.
    if (event.query.trim() === 'SELECT 1') return;
    queries += 1;
  });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(testEnv(url), APP_INFO, { backgroundJobs: false })],
  })
    .overrideProvider(PRISMA_CLIENT)
    .useValue(counted)
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(new NullMail())
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');
  prisma = app.get<PrismaClient>(PRISMA_CLIENT);

  await seedAccess();
  const started = Date.now();
  await bulkLoad();
  timings.push(`bulk load: ${String(Date.now() - started)} ms`);
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
  const login = await request(server())
    .post(`/${API_PREFIX}/auth/login`)
    .set('X-Client-Type', 'mobile')
    .send(ADMIN);
  token = login.body.data.accessToken as string;
}, 600_000);

afterAll(async () => {
  console.log(`Phase 12 report timings at DOCUMENT 26 volume:\n  ${timings.join('\n  ')}`);
  vi.useRealTimers();
  await app.close();
  await socket.stop();
  await pglite.close();
});

beforeEach(() => {
  redis.reset();
});

/** Resolves once no query event has arrived for 50 ms (timers are real; only Date is faked). */
async function queryEventsSettled(): Promise<void> {
  let seen = -1;
  while (seen !== queries) {
    seen = queries;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function timed(
  label: string,
  path: string,
): Promise<{ ms: number; queries: number; body: Record<string, unknown> }> {
  // Prisma emits query events asynchronously: a trailing event of the
  // previous request can arrive after the reset under load. Count only once
  // the stream is quiet, before and after.
  await queryEventsSettled();
  queries = 0;
  // Date is faked for the application; the wall clock is read from hrtime.
  const start = process.hrtime.bigint();
  const response = await get(path);
  const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
  await queryEventsSettled();
  expect(response.status, `${label}: ${JSON.stringify(response.body).slice(0, 300)}`).toBe(200);
  timings.push(`${label}: ${String(ms)} ms, ${String(queries)} SQL statements`);
  return { ms, queries, body: response.body.data as Record<string, unknown> };
}

const YEAR = 'from=2025-05-01&to=2026-04-30';

describe('every report over twelve months of DOCUMENT 26 data answers in under 5 seconds', () => {
  it('the data set is DOCUMENT 26’s', async () => {
    const counts = await withTenant(prisma, COMPANY, async (tx) => ({
      employees: await tx.employee.count(),
      attendance: await tx.attendanceRecord.count(),
      tasks: await tx.task.count(),
      products: await tx.product.count(),
      movements: await tx.stockMovement.count(),
    }));
    expect(counts).toEqual({
      employees: 200,
      attendance: 200 * 730,
      tasks: 10_000,
      products: 5_000,
      movements: 200_000,
    });
  });

  for (const [key, path] of [
    ['attendance', `/reports/attendance?${YEAR}`],
    ['tasks', `/reports/tasks?${YEAR}`],
    ['goals', `/reports/goals?${YEAR}`],
    ['payroll', `/reports/payroll?${YEAR}`],
    ['inventory', '/reports/inventory'],
    ['warehouse', `/reports/warehouse?${YEAR}`],
    ['stock-movements', `/reports/stock-movements?${YEAR}`],
    [
      'performance (one month, 200 employees)',
      '/reports/performance?from=2026-04-01&to=2026-04-30',
    ],
  ] as const) {
    it(
      key,
      async () => {
        const result = await timed(key, path);
        expect(result.ms).toBeLessThan(TARGET_MS);
      },
      60_000,
    );
  }

  it('the figures are whole: twelve months of attendance for 200 people, 200,000 movements’ value', async () => {
    const attendance = await timed('attendance again', `/reports/attendance?${YEAR}`);
    const summary = attendance.body.summary as Record<string, number>;
    expect(summary.employees).toBe(200);
    // 365 days a year per employee, every one recorded.
    expect(summary.recorded_days).toBe(200 * 365);
    const inventory = await timed('inventory again', '/reports/inventory');
    // 5,000 products × 99 units × 10.00.
    expect((inventory.body.summary as Record<string, string>).inventory_value).toBe('4950000.00');
  }, 60_000);
});

describe('no N+1: a report’s statement count does not grow with the people it covers', () => {
  // A filtered request makes exactly one more statement than an unfiltered
  // one — it reads the filter's name for the report's self-describing
  // metadata. So 1 employee (an employee filter) and 20 (a department filter)
  // must issue the same number; 200 (no filter) exactly one fewer.
  for (const [key, query] of [
    ['attendance', YEAR],
    ['tasks', YEAR],
    ['goals', YEAR],
    ['payroll', YEAR],
    ['performance', 'from=2026-04-01&to=2026-04-30'],
  ] as const) {
    it(`${key}: 1, 20 and 200 employees — the statement count does not grow`, async () => {
      // Employee 12 has an April goal, like others in the department, so no
      // statement is skipped for an empty set (the goal history read is).
      const one = await timed(
        `${key} (1 employee)`,
        `/reports/${key}?${query}&employee_id=00000000-0000-7000-8000-0000000e0012`,
      );
      const twenty = await timed(
        `${key} (20 employees)`,
        `/reports/${key}?${query}&department_id=${smallDepartment}`,
      );
      const all = await timed(`${key} (200 employees)`, `/reports/${key}?${query}`);
      expect(twenty.queries).toBe(one.queries);
      expect(all.queries).toBe(twenty.queries - 1);
    }, 60_000);
  }
});

describe('the whole ledger exports in the background, in batches', () => {
  it('200,000 movements → a queued export whose file holds every row', async () => {
    const start = process.hrtime.bigint();
    const queued = await request(server())
      .post(`/${API_PREFIX}/reports/stock-movements/export`)
      .set('Authorization', `Bearer ${token}`)
      .send({ format: 'csv', from: '2024-05-01', to: '2026-04-30', confirm_large_range: true });
    expect(queued.status).toBe(202);
    const id = queued.body.data.id as string;
    let status = 'queued';
    for (let i = 0; i < 600 && status !== 'completed' && status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setImmediate(resolve));
      const response = await get(`/reports/exports/${id}`);
      status = response.body.data.status as string;
      if (status === 'completed') {
        expect(response.body.data.row_count).toBe(200_000);
      }
    }
    expect(status).toBe('completed');
    const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    timings.push(`stock-movements export, 200,000 rows (background): ${String(ms)} ms`);
    const file = [...storage.objects.values()].find((object) => object.key.endsWith(`${id}.csv`));
    const lines = (file?.body.toString('utf8') ?? '')
      .split('\r\n')
      .filter((line) => line.length > 0);
    // The preamble, the header, and the 200,000 rows.
    expect(lines.filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line))).toHaveLength(200_000);
  }, 600_000);
});
