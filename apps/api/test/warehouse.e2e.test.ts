/**
 * Phase 13 end-to-end — DOCUMENT 25 Phase 13 ("a transfer either completes
 * fully or not at all, proven by a forced-failure test"), DOCUMENT 17,
 * DOCUMENT 08 §4.11, DOCUMENT 26 (stock transfer, concurrency, MANAGER
 * denied, no role can update or delete a movement).
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with RLS under
 * `ufuq_app`, and the real ledger triggers. Products and their opening stock
 * are seeded through the internal `StockLedgerService` — the one ledger
 * writer — because Phase 14 owns the product catalogue and every inbound
 * movement endpoint (approved decision).
 *
 * Every quantity and amount is asserted as an exact string.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';
import { AuditDispatcher, AUDIT_RETRY_QUEUE } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import { StockLedgerService } from '../src/warehouse/stock-ledger.service.js';

import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
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
const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

let adminUserId = '';
const w: Record<string, string> = {};
const p: Record<string, string> = {};
let warehouseB = '';
let productB = '';

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
  for (const [companyId, slug, admin] of [
    [COMPANY_A, 'company-a', ADMIN_A],
    [COMPANY_B, 'company-b', ADMIN_B],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({ data: { id: companyId, name: slug, slug, timezone: CAIRO } });
      const user = await tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: admin.email,
          passwordHash,
          roleId: roleIdByKey.get('admin') as string,
          status: 'active',
        },
      });
      if (companyId === COMPANY_A) adminUserId = user.id;
    });
  }
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
}

interface Account {
  readonly email: string;
  readonly password: string;
}

const tokens = new Map<string, string>();

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
  const agent = request(server());
  const auth = <T extends { set: (k: string, v: string) => T }>(b: T): T =>
    b.set('Authorization', `Bearer ${token as string}`);
  return {
    get: (path: string) => auth(agent.get(`/${API_PREFIX}${path}`)),
    post: (path: string) => auth(agent.post(`/${API_PREFIX}${path}`)),
    patch: (path: string) => auth(agent.patch(`/${API_PREFIX}${path}`)),
  };
}

async function createUser(
  email: string,
  password: string,
  roleKey: string,
  schedule: string,
  code: string,
) {
  const r = await (await api(ADMIN_A)).post('/employees').send({
    first_name: 'Test',
    last_name: code,
    email,
    employee_code: code,
    role_key: roleKey,
    work_schedule_id: schedule,
    joining_date: '2026-01-05',
    send_invitation: true,
  });
  expect(r.status).toBe(201);
  const message = [...mail.sent].reverse().find((m) => m.to === email) as MailMessage;
  const token = /#token=([^\s"']+)/.exec(message.text)?.[1] as string;
  const accepted = await request(server())
    .post(`/${API_PREFIX}/auth/accept-invitation`)
    .send({ token: decodeURIComponent(token), password, accept_terms: true });
  expect(accepted.status).toBe(200);
}

async function asOwner<T>(run: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe('RESET ROLE');
  try {
    return await run();
  } finally {
    await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
  }
}

async function withFailingTrigger(table: string, condition: string, run: () => Promise<void>) {
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

/** Opening stock through the one ledger writer (no Phase 13 endpoint brings stock in). */
async function seedStock(
  companyId: string,
  userId: string,
  productId: string,
  warehouseId: string,
  qty: string,
  cost: string,
): Promise<void> {
  const ledger = app.get(StockLedgerService);
  await app.get(AuditDispatcher).withTenant(companyId, async (tx) => {
    const locked = await ledger.lock(tx, companyId, [{ productId, warehouseId }]);
    await ledger.post(
      tx,
      companyId,
      userId,
      locked,
      [
        {
          productId,
          warehouseId,
          type: 'manual_addition',
          quantity: Decimal.parse(qty, 3),
          unitCost: Decimal.parse(cost, 2),
          reason: 'Opening balance (test seed)',
        },
      ],
      new Date(),
    );
  });
}

async function createProduct(companyId: string, sku: string, unit: string): Promise<string> {
  const id = generateId();
  await withTenant(prisma, companyId, (tx) =>
    tx.product.create({
      data: { id, companyId, nameAr: `منتج ${sku}`, nameEn: `Product ${sku}`, sku, unit },
    }),
  );
  return id;
}

async function balance(productId: string, warehouseId: string) {
  const row = await withTenant(prisma, COMPANY_A, (tx) =>
    tx.productStock.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } }),
  );
  return row === null
    ? null
    : {
        quantity: Decimal.parse(row.quantity.toString(), 3).toString(),
        average_cost: Decimal.parse(row.averageCost.toString(), 2).toString(),
      };
}

async function movementCount(): Promise<number> {
  return withTenant(prisma, COMPANY_A, (tx) => tx.stockMovement.count());
}

async function audits(action: string) {
  return withTenant(prisma, COMPANY_A, (tx) =>
    tx.auditLog.findMany({ where: { action: action as never } }),
  );
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
    .overrideProvider(OBJECT_STORAGE)
    .useValue(new InMemoryObjectStorage())
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
    name: 'Week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'none',
    is_default: true,
    days: Array.from({ length: 7 }, (_, day) =>
      day <= 4
        ? { day_of_week: day, is_working_day: true, start_time: '09:00', end_time: '17:00' }
        : { day_of_week: day, is_working_day: false },
    ),
  });
  await createUser(
    MANAGER.email,
    MANAGER.password,
    'manager',
    schedule.body.data.id as string,
    'MGR-1',
  );
  await createUser(
    WORKER.email,
    WORKER.password,
    'employee',
    schedule.body.data.id as string,
    'EMP-1',
  );
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

// ---------------------------------------------------------------------------
// Access — DOCUMENT 17 "Users", DOCUMENT 26 §5
// ---------------------------------------------------------------------------

describe('access: ADMIN only in V1', () => {
  const reads = [
    '/warehouses',
    '/warehouses/dashboard',
    '/warehouses/transfers',
    '/stock-movements',
  ];

  it('401 without a session', async () => {
    expect((await request(server()).get(`/${API_PREFIX}/warehouses`)).status).toBe(401);
  });

  it('MANAGER and EMPLOYEE are refused every warehouse and stock endpoint', async () => {
    for (const account of [MANAGER, WORKER]) {
      const client = await api(account);
      for (const path of reads)
        expect((await client.get(path)).status, `${account.email} ${path}`).toBe(403);
      expect(
        (await client.post('/warehouses').send({ name_ar: 'م', name_en: 'W', type: 'main' }))
          .status,
      ).toBe(403);
      expect(
        (
          await client.post('/warehouses/transfers').send({
            source_warehouse_id: generateId(),
            destination_warehouse_id: generateId(),
            lines: [],
          })
        ).status,
      ).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Warehouses — DOCUMENT 17 "Data", DOCUMENT 04 B20
// ---------------------------------------------------------------------------

describe('warehouses: every type, managed, never deleted', () => {
  it('creates a location of every type — an online channel is just a type', async () => {
    const admin = await api(ADMIN_A);
    for (const [key, type, name] of [
      ['main', 'main', 'Main warehouse'],
      ['branch', 'branch', 'Alexandria branch'],
      ['store', 'store', 'City store'],
      ['production', 'production', 'Workshop'],
      ['online', 'online', 'Online store'],
    ] as const) {
      const r = await admin
        .post('/warehouses')
        .send({ name_ar: `موقع ${name}`, name_en: name, type, address: 'Cairo' });
      expect(r.status).toBe(201);
      expect(r.body.data).toMatchObject({
        type,
        is_active: true,
        product_count: 0,
        total_quantity: '0.000',
        stock_value: '0.00',
      });
      w[key] = r.body.data.id as string;
    }
    expect(await audits('WAREHOUSE_CREATED')).toHaveLength(5);
    const b = await (await api(ADMIN_B))
      .post('/warehouses')
      .send({ name_ar: 'ب', name_en: 'B main', type: 'main' });
    warehouseB = b.body.data.id as string;
  });

  it('validates the type and the fields, and rejects unknown fields', async () => {
    const admin = await api(ADMIN_A);
    for (const body of [
      { name_ar: 'م', name_en: 'W', type: 'marketplace' },
      { name_ar: '', name_en: 'W', type: 'main' },
      { name_en: 'W', type: 'main' },
      { name_ar: 'م', name_en: 'W', type: 'main', quantity: '5' },
      { name_ar: 'م', name_en: 'W', type: 'main', company_id: COMPANY_B },
    ]) {
      expect((await admin.post('/warehouses').send(body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it('lists with pagination and filters; another company’s location is 404', async () => {
    const admin = await api(ADMIN_A);
    const page = await admin.get('/warehouses?per_page=2');
    expect(page.body.meta).toMatchObject({ page: 1, per_page: 2, total: 5 });
    const online = await admin.get('/warehouses?type=online');
    expect(online.body.data.map((x: { id: string }) => x.id)).toEqual([w.online]);
    expect((await admin.get(`/warehouses/${warehouseB}`)).status).toBe(404);
    expect((await admin.patch(`/warehouses/${warehouseB}`).send({ name_en: 'x' })).status).toBe(
      404,
    );
    expect((await admin.get(`/warehouses/${warehouseB}/stock`)).status).toBe(404);
    expect((await admin.get('/warehouses/not-a-uuid')).status).toBe(400);
  });

  it('edits a location, audited with only what changed', async () => {
    const r = await (await api(ADMIN_A))
      .patch(`/warehouses/${w.branch}`)
      .send({ name_en: 'Alexandria', address: null });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name_en: 'Alexandria', address: null });
    const [entry] = await audits('WAREHOUSE_UPDATED');
    expect(entry?.oldValues).toEqual({ name_en: 'Alexandria branch', address: 'Cairo' });
    expect(entry?.newValues).toEqual({ name_en: 'Alexandria', address: null });
  });
});

// ---------------------------------------------------------------------------
// Stock — DOCUMENT 17 rules 1, 3
// ---------------------------------------------------------------------------

describe('per-location stock, derived from the ledger, never written directly', () => {
  it('shows exactly what each location holds', async () => {
    p.fabric = await createProduct(COMPANY_A, 'FAB-1', 'metre');
    p.box = await createProduct(COMPANY_A, 'BOX-1', 'piece');
    productB = await createProduct(COMPANY_B, 'FAB-1', 'metre');
    await seedStock(
      COMPANY_A,
      adminUserId,
      p.fabric as string,
      w.main as string,
      '120.500',
      '35.00',
    );
    await seedStock(COMPANY_A, adminUserId, p.box as string, w.main as string, '10.000', '12.50');
    await seedStock(
      COMPANY_A,
      adminUserId,
      p.fabric as string,
      w.online as string,
      '10.000',
      '40.00',
    );
    const stock = await (await api(ADMIN_A)).get(`/warehouses/${w.main}/stock`);
    expect(stock.status).toBe(200);
    expect(
      stock.body.data.map((r: Record<string, unknown>) => [
        (r.product as { sku: string }).sku,
        r.quantity,
        r.average_cost,
        r.stock_value,
      ]),
    ).toEqual([
      ['BOX-1', '10.000', '12.50', '125.00'],
      ['FAB-1', '120.500', '35.00', '4217.50'],
    ]);
    const main = await (await api(ADMIN_A)).get(`/warehouses/${w.main}`);
    expect(main.body.data).toMatchObject({
      product_count: 2,
      total_quantity: '130.500',
      stock_value: '4342.50',
    });
  });

  it('there is no way to set a quantity through the API', async () => {
    const admin = await api(ADMIN_A);
    expect(
      (await admin.patch(`/products/${p.fabric as string}/quantity`).send({ quantity: '999' }))
        .status,
    ).toBe(404);
    expect((await admin.patch(`/warehouses/${w.main}`).send({ quantity: '999' })).status).toBe(422);
    // Phase 14 adds POST /stock-movements, which creates a movement; nothing edits one.
    expect(
      (await admin.patch(`/stock-movements/${generateId()}`).send({ quantity: '1' })).status,
    ).toBe(404);
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '120.500',
      average_cost: '35.00',
    });
  });

  it('nor through the database: the cache refuses a quantity without a movement', async () => {
    await expect(
      withTenant(prisma, COMPANY_A, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE product_stock SET quantity = 999 WHERE product_id = '${p.fabric as string}'`,
        ),
      ),
    ).rejects.toThrow(/does not match the ledger/);
  });
});

// ---------------------------------------------------------------------------
// Transfers — DOCUMENT 17 rule 4, DOCUMENT 05 FLOW 18
// ---------------------------------------------------------------------------

describe('transfers: paired, atomic, value preserved', () => {
  let groupId = '';

  it('moves two products in one transaction: two legs each, one transfer group', async () => {
    const before = await movementCount();
    const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.online,
      lines: [
        { product_id: p.fabric, quantity: '20.250' },
        { product_id: p.box, quantity: '4' },
      ],
      note: 'Restock the online channel',
    });
    expect(r.status).toBe(201);
    groupId = r.body.data.transfer_group_id as string;
    expect(
      r.body.data.lines.map((l: Record<string, unknown>) => [
        l.quantity,
        l.unit_cost,
        l.source_balance_after,
        l.destination_balance_after,
      ]),
    ).toEqual([
      ['20.250', '35.00', '100.250', '30.250'],
      ['4.000', '12.50', '6.000', '4.000'],
    ]);
    // 20.250 × 35.00 + 4 × 12.50 = 708.75 + 50.00
    expect(r.body.data.value).toBe('758.75');
    expect(await movementCount()).toBe(before + 4);
    const legs = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.stockMovement.findMany({
        where: { transferGroupId: groupId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(
      legs.map((m) => [
        m.type,
        Decimal.parse(m.quantity.toString(), 3).toString(),
        m.transferGroupId,
      ]),
    ).toEqual([
      ['transfer_out', '-20.250', groupId],
      ['transfer_in', '20.250', groupId],
      ['transfer_out', '-4.000', groupId],
      ['transfer_in', '4.000', groupId],
    ]);
  });

  it('decrements the source and increments the destination exactly; the destination average follows rule 11', async () => {
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '100.250',
      average_cost: '35.00',
    });
    // (10 × 40 + 20.25 × 35) ÷ 30.25 = 1108.75 ÷ 30.25 = 36.652… → 36.65
    expect(await balance(p.fabric as string, w.online as string)).toEqual({
      quantity: '30.250',
      average_cost: '36.65',
    });
    expect(await balance(p.box as string, w.main as string)).toEqual({
      quantity: '6.000',
      average_cost: '12.50',
    });
    expect(await balance(p.box as string, w.online as string)).toEqual({
      quantity: '4.000',
      average_cost: '12.50',
    });
  });

  it('is audited once, after commit, naming every movement', async () => {
    const entries = await audits('STOCK_TRANSFER_EXECUTED');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entityId).toBe(groupId);
    expect((entries[0]?.newValues as { movement_ids: string[] }).movement_ids).toHaveLength(4);
    expect(retryQueue.entries).toEqual([]);
  });

  it('lists transfers and the ledger with its filters', async () => {
    const admin = await api(ADMIN_A);
    const list = await admin.get('/warehouses/transfers');
    expect(list.body.data.map((t: { transfer_group_id: string }) => t.transfer_group_id)).toEqual([
      groupId,
    ]);
    const outs = await admin.get(`/stock-movements?warehouse_id=${w.main}&type=transfer_out`);
    expect(outs.body.meta.total).toBe(2);
    const fabric = await admin.get(`/stock-movements?product_id=${p.fabric as string}&per_page=1`);
    expect(fabric.body.meta).toMatchObject({ total: 4, per_page: 1 });
    expect(fabric.body.data[0].type).toBe('transfer_in');
    expect((await admin.get(`/warehouses/transfers/${generateId()}`)).status).toBe(404);
  });

  it('validates the request before touching anything', async () => {
    const admin = await api(ADMIN_A);
    const before = await movementCount();
    const send = (body: Record<string, unknown>) =>
      admin.post('/warehouses/transfers').send({
        source_warehouse_id: w.main,
        destination_warehouse_id: w.online,
        lines: [{ product_id: p.fabric, quantity: '1' }],
        ...body,
      });
    const cases: [Record<string, unknown>, string][] = [
      [{ destination_warehouse_id: w.main }, 'same_location'],
      [{ lines: [{ product_id: p.fabric, quantity: '0' }] }, 'invalid'],
      [{ lines: [{ product_id: p.fabric, quantity: '1.0001' }] }, 'invalid'],
      [
        {
          lines: [
            { product_id: p.fabric, quantity: '1' },
            { product_id: p.fabric, quantity: '2' },
          ],
        },
        'duplicate_product',
      ],
      [{ lines: [{ product_id: generateId(), quantity: '1' }] }, 'not_found'],
      [{ lines: [{ product_id: productB, quantity: '1' }] }, 'not_found'],
      [{ destination_warehouse_id: warehouseB }, 'not_found'],
      [{ destination_warehouse_id: generateId() }, 'not_found'],
    ];
    for (const [body, issue] of cases) {
      const r = await send(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(JSON.stringify(r.body.error.fields)).toContain(issue);
    }
    for (const body of [
      { lines: [] },
      { lines: [{ product_id: p.fabric, quantity: 1 }] },
      { surprise: true },
      { lines: [{ product_id: p.fabric, quantity: '1', unit_cost: '1' }] },
    ]) {
      expect((await send(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(await movementCount()).toBe(before);
  });

  it('insufficient stock is refused, naming what is available — no negative stock', async () => {
    const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.store,
      lines: [
        { product_id: p.box, quantity: '1' },
        { product_id: p.fabric, quantity: '200' },
      ],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
    expect(r.body.error.fields).toMatchObject({
      available: ['100.250'],
      requested: ['200.000'],
      product_id: [p.fabric],
    });
    // The first line was not applied either.
    expect(await balance(p.box as string, w.main as string)).toEqual({
      quantity: '6.000',
      average_cost: '12.50',
    });
    expect(await balance(p.box as string, w.store as string)).toBeNull();
  });
});

describe('a transfer completes fully or not at all (DOCUMENT 25 Phase 13 exit)', () => {
  it('a failure on the inbound leg, after the outbound leg was written, leaves nothing changed', async () => {
    const before = {
      movements: await movementCount(),
      source: await balance(p.fabric as string, w.main as string),
      destination: await balance(p.fabric as string, w.production as string),
      audits: (await audits('STOCK_TRANSFER_EXECUTED')).length,
    };
    await withFailingTrigger('stock_movements', `NEW.type = 'transfer_in'`, async () => {
      const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
        source_warehouse_id: w.main,
        destination_warehouse_id: w.production,
        lines: [{ product_id: p.fabric, quantity: '5' }],
      });
      expect(r.status).toBe(500);
    });
    expect(await movementCount()).toBe(before.movements);
    expect(await balance(p.fabric as string, w.main as string)).toEqual(before.source);
    expect(await balance(p.fabric as string, w.production as string)).toEqual(before.destination);
    expect((await audits('STOCK_TRANSFER_EXECUTED')).length).toBe(before.audits);
  });

  it('a failure updating the destination cache rolls back both legs too', async () => {
    const before = await movementCount();
    await withFailingTrigger(
      'product_stock',
      `TG_OP = 'UPDATE' AND NEW.warehouse_id = '${w.production as string}'::uuid AND NEW.quantity > 0`,
      async () => {
        const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
          source_warehouse_id: w.main,
          destination_warehouse_id: w.production,
          lines: [{ product_id: p.fabric, quantity: '5' }],
        });
        expect(r.status).toBe(500);
      },
    );
    expect(await movementCount()).toBe(before);
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '100.250',
      average_cost: '35.00',
    });
  });
});

describe('concurrency and idempotency', () => {
  it('two concurrent transfers that together exceed the stock: one succeeds, the other is refused — no lost update', async () => {
    const admin = await api(ADMIN_A);
    const send = () =>
      admin.post('/warehouses/transfers').send({
        source_warehouse_id: w.main,
        destination_warehouse_id: w.branch,
        lines: [{ product_id: p.fabric, quantity: '60' }],
      });
    const results = await Promise.all([send(), send()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '40.250',
      average_cost: '35.00',
    });
    expect(await balance(p.fabric as string, w.branch as string)).toEqual({
      quantity: '60.000',
      average_cost: '35.00',
    });
  });

  it('the same Idempotency-Key, sent twice at once, creates one transfer', async () => {
    const admin = await api(ADMIN_A);
    const before = await movementCount();
    const send = () =>
      admin
        .post('/warehouses/transfers')
        .set('Idempotency-Key', 'branch-to-store-1')
        .send({
          source_warehouse_id: w.branch,
          destination_warehouse_id: w.store,
          lines: [{ product_id: p.fabric, quantity: '10' }],
        });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.transfer_group_id).toBe(b.body.data.transfer_group_id);
    expect(await movementCount()).toBe(before + 2);
    expect(await balance(p.fabric as string, w.branch as string)).toEqual({
      quantity: '50.000',
      average_cost: '35.00',
    });
    const reused = await admin
      .post('/warehouses/transfers')
      .set('Idempotency-Key', 'branch-to-store-1')
      .send({
        source_warehouse_id: w.branch,
        destination_warehouse_id: w.store,
        lines: [{ product_id: p.fabric, quantity: '11' }],
      });
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await movementCount()).toBe(before + 2);
  });
});

// ---------------------------------------------------------------------------
// Deactivation and immutability
// ---------------------------------------------------------------------------

describe('deactivation keeps history; movements never change', () => {
  it('a location holding stock cannot be deactivated', async () => {
    const r = await (await api(ADMIN_A)).patch(`/warehouses/${w.main}`).send({ is_active: false });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('WAREHOUSE_HAS_STOCK');
    expect((await (await api(ADMIN_A)).get(`/warehouses/${w.main}`)).body.data.is_active).toBe(
      true,
    );
  });

  it('once emptied by transfer it can be; an inactive location takes no transfer; reactivation works', async () => {
    const admin = await api(ADMIN_A);
    expect(
      (
        await admin.post('/warehouses/transfers').send({
          source_warehouse_id: w.store,
          destination_warehouse_id: w.main,
          lines: [{ product_id: p.fabric, quantity: '10' }],
        })
      ).status,
    ).toBe(201);
    const off = await admin.patch(`/warehouses/${w.store}`).send({ is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.data.is_active).toBe(false);
    expect(await audits('WAREHOUSE_DEACTIVATED')).toHaveLength(1);
    const blocked = await admin.post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.store,
      lines: [{ product_id: p.fabric, quantity: '1' }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('WAREHOUSE_INACTIVE');
    // Its history stays readable.
    expect((await admin.get(`/stock-movements?warehouse_id=${w.store}`)).body.meta.total).toBe(2);
    expect(
      (await admin.patch(`/warehouses/${w.store}`).send({ is_active: true })).body.data.is_active,
    ).toBe(true);
  });

  it('no role can update or delete a movement (DOCUMENT 26 §5)', async () => {
    for (const sql of ['UPDATE stock_movements SET reason = NULL', 'DELETE FROM stock_movements']) {
      await expect(
        withTenant(prisma, COMPANY_A, (tx) => tx.$executeRawUnsafe(sql)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwner(() => prisma.$transaction((tx) => tx.$executeRawUnsafe(sql))),
      ).rejects.toThrow(/immutable/);
    }
  });

  it('every cached balance equals its ledger — the cache is derived, not a second truth', async () => {
    const rows = await withTenant(prisma, COMPANY_A, async (tx) => {
      const stock = await tx.productStock.findMany();
      const movements = await tx.stockMovement.findMany();
      return stock.map((s) => ({
        cached: Decimal.parse(s.quantity.toString(), 3).toString(),
        ledger: Decimal.sum(
          movements
            .filter((m) => m.productId === s.productId && m.warehouseId === s.warehouseId)
            .map((m) => Decimal.parse(m.quantity.toString(), 3)),
          3,
        ).toString(),
      }));
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.cached).toBe(row.ledger);
  });
});

describe('the warehouse dashboard', () => {
  it('reports what the ledger holds, exactly', async () => {
    const r = await (await api(ADMIN_A)).get('/warehouses/dashboard');
    expect(r.status).toBe(200);
    const d = r.body.data;
    // fabric: main 50.250 @35, online 30.250 @36.65, branch 50 @35; box: main 6 @12.50, online 4 @12.50
    expect(d.kpis).toMatchObject({
      locations_total: 5,
      locations_active: 5,
      products_in_stock: 2,
      total_stock_units: '140.500',
    });
    // 50.25×35 + 30.25×36.65 + 50×35 + 6×12.5 + 4×12.5 = 1758.75 + 1108.6625 + 1750 + 75 + 50
    expect(d.kpis.total_inventory_value).toBe('4742.41');
    expect(d.by_location).toHaveLength(5);
    expect(d.recent_movements.length).toBeLessThanOrEqual(20);
    expect(d.activity_trend).toHaveLength(30);
    expect(
      d.activity_trend.reduce((n: number, x: { movements: number }) => n + x.movements, 0),
    ).toBe(d.recent_movements.length > 0 ? await movementCount() : 0);
    // Phase 14 completed the elements Phase 13 deferred (see inventory.e2e).
    expect(d.deferred).toEqual([]);
    expect(d.kpis).toMatchObject({ total_products: 2, low_stock_count: 0, out_of_stock_count: 0 });
    const b = await (await api(ADMIN_B)).get('/warehouses/dashboard');
    expect(b.body.data.kpis.total_stock_units).toBe('0.000');
  });
});
