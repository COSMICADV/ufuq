/**
 * Phase 14 end-to-end — DOCUMENT 25 Phase 14 exit criteria, DOCUMENT 17,
 * DOCUMENT 08 §4.11, DOCUMENT 05 FLOWs 17–18, DOCUMENT 26 (inventory).
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with RLS under
 * `ufuq_app`, and the real ledger triggers. Every quantity and amount is
 * asserted as an exact string.
 *
 * Concurrency note: the harness's PGlite serves one connection, so concurrent
 * requests reach the database one transaction at a time. The tests below
 * prove the end-to-end outcome (one winner, exact balances, no duplicate);
 * `packages/db/test/phase14-rls.test.ts` proves the database itself refuses a
 * movement computed from a stale balance — the write a lost update needs.
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
import { AUDIT_RETRY_QUEUE } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';
import { INVENTORY_EVENT_SINK } from '../src/inventory/inventory-events.js';
import type { InventoryEvent, InventoryEventSink } from '../src/inventory/inventory-events.js';
import { ReconciliationRunner } from '../src/inventory/reconciliation-jobs.js';
import { StockMovementService } from '../src/inventory/stock-movements.service.js';
import { StockLedgerService } from '../src/warehouse/stock-ledger.service.js';

import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
import { allMigrationsSql } from './all-migrations.js';
import { SAMPLES } from './attachment-samples.js';

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

class CapturingEvents implements InventoryEventSink {
  readonly events: InventoryEvent[] = [];
  handle(event: InventoryEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  take(): InventoryEvent[] {
    return this.events.splice(0);
  }
}
const sink = new CapturingEvents();

const COMPANY_A = generateId();
const COMPANY_B = generateId();
const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };
const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

const w: Record<string, string> = {};
const p: Record<string, string> = {};
let warehouseB = '';
let supplierB = '';
let categoryB = '';
let productB = '';
let supplier = '';
let category = '';

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
    delete: (path: string) => auth(agent.delete(`/${API_PREFIX}${path}`)),
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
    .overrideProvider(INVENTORY_EVENT_SINK)
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
// Helpers
// ---------------------------------------------------------------------------

let keySeq = 0;

/** POST /stock-movements with a fresh Idempotency-Key unless one is given. */
async function move(body: Record<string, unknown>, key?: string, account: Account = ADMIN_A) {
  keySeq += 1;
  // Fixed before the first await, so concurrent calls never share a key.
  const idempotencyKey = key ?? `movement-${String(keySeq)}`;
  return (await api(account))
    .post('/stock-movements')
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
}

async function productTotal(productId: string): Promise<string> {
  const r = await (await api(ADMIN_A)).get(`/products/${productId}`);
  return r.body.data.total_quantity as string;
}

async function auditCount(action: string): Promise<number> {
  return (await audits(action)).length;
}

async function snapshot() {
  return withTenant(prisma, COMPANY_A, async (tx) => ({
    movements: await tx.stockMovement.count(),
    products: await tx.product.count(),
    stock: (await tx.productStock.findMany({ orderBy: { id: 'asc' } })).map((s) => [
      s.id,
      s.quantity.toString(),
      s.averageCost.toString(),
    ]),
    audits: await tx.auditLog.count(),
  }));
}

/** Every cache row equals the sum of its movements (rule 3). */
async function cacheMatchesLedger(companyId: string = COMPANY_A): Promise<void> {
  await withTenant(prisma, companyId, async (tx) => {
    const stock = await tx.productStock.findMany();
    const movements = await tx.stockMovement.findMany();
    for (const s of stock) {
      const ledger = Decimal.sum(
        movements
          .filter((m) => m.productId === s.productId && m.warehouseId === s.warehouseId)
          .map((m) => Decimal.parse(m.quantity.toString(), 3)),
        3,
      );
      expect(Decimal.parse(s.quantity.toString(), 3).toString()).toBe(ledger.toString());
    }
  });
}

async function createProduct(body: Record<string, unknown>, account: Account = ADMIN_A) {
  return (await api(account)).post('/products').send(body);
}

// ---------------------------------------------------------------------------
// Access — DOCUMENT 17 "Users": ADMIN only in V1
// ---------------------------------------------------------------------------

describe('access: ADMIN only', () => {
  it('401 without a session', async () => {
    for (const path of ['/products', '/suppliers', '/product-categories', '/inventory/alerts']) {
      expect((await request(server()).get(`/${API_PREFIX}${path}`)).status, path).toBe(401);
    }
  });

  it('MANAGER and EMPLOYEE are refused every inventory endpoint, reads and writes', async () => {
    for (const account of [MANAGER, WORKER]) {
      const client = await api(account);
      for (const path of [
        '/products',
        `/products/${generateId()}`,
        `/products/${generateId()}/stock`,
        `/products/${generateId()}/movements`,
        '/product-categories',
        '/suppliers',
        '/stock-movements',
        '/inventory/alerts',
      ]) {
        expect((await client.get(path)).status, `${account.email} GET ${path}`).toBe(403);
      }
      for (const [path, body] of [
        ['/products', { name_ar: 'م', name_en: 'P', sku: 'X', unit: 'piece' }],
        ['/product-categories', { name_ar: 'ف', name_en: 'C' }],
        ['/suppliers', { name: 'S' }],
        ['/inventory/reconciliation', {}],
      ] as const) {
        expect((await client.post(path).send(body)).status, `${account.email} POST ${path}`).toBe(
          403,
        );
      }
      const movement = await move(
        {
          product_id: generateId(),
          warehouse_id: generateId(),
          type: 'manual_addition',
          quantity: '1',
        },
        undefined,
        account,
      );
      expect(movement.status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// Locations, categories, suppliers
// ---------------------------------------------------------------------------

describe('categories and suppliers (same company only)', () => {
  it('sets up locations in both companies', async () => {
    const admin = await api(ADMIN_A);
    for (const [key, type] of [
      ['main', 'main'],
      ['branch', 'branch'],
      ['store', 'store'],
    ] as const) {
      const r = await admin
        .post('/warehouses')
        .send({ name_ar: `موقع ${key}`, name_en: `Location ${key}`, type });
      expect(r.status).toBe(201);
      w[key] = r.body.data.id as string;
    }
    const b = await (await api(ADMIN_B))
      .post('/warehouses')
      .send({ name_ar: 'ب', name_en: 'B main', type: 'main' });
    warehouseB = b.body.data.id as string;
  });

  it('creates categories, with a parent from the same company; audited product_category.created', async () => {
    const admin = await api(ADMIN_A);
    const parent = await admin
      .post('/product-categories')
      .send({ name_ar: 'أقمشة', name_en: 'Fabrics' });
    expect(parent.status).toBe(201);
    category = parent.body.data.id as string;
    const child = await admin
      .post('/product-categories')
      .send({ name_ar: 'قطن', name_en: 'Cotton', parent_id: category });
    expect(child.body.data).toMatchObject({ parent_id: category, product_count: 0 });
    const b = await (await api(ADMIN_B))
      .post('/product-categories')
      .send({ name_ar: 'ب', name_en: 'B cat' });
    categoryB = b.body.data.id as string;
    const cross = await admin
      .post('/product-categories')
      .send({ name_ar: 'x', name_en: 'X', parent_id: categoryB });
    expect(cross.status).toBe(422);
    expect(cross.body.error.fields).toEqual({ parent_id: ['not_found'] });
    for (const body of [
      { name_ar: '', name_en: 'X' },
      { name_en: 'X' },
      { name_ar: 'x', name_en: 'X', extra: 1 },
    ]) {
      expect((await admin.post('/product-categories').send(body)).status).toBe(422);
    }
    expect(await auditCount('PRODUCT_CATEGORY_CREATED')).toBe(2);
    const list = await admin.get('/product-categories');
    expect(list.body.data.map((c: { name_en: string }) => c.name_en)).toEqual([
      'Cotton',
      'Fabrics',
    ]);
  });

  it('creates, lists, reads and edits suppliers; audited supplier.created / supplier.updated', async () => {
    const admin = await api(ADMIN_A);
    const r = await admin.post('/suppliers').send({
      name: 'Delta Textiles',
      contact_person: 'Mona',
      phone: '+20 100 123 4567',
      email: 'Sales@Delta.TEST',
      address: 'Mahalla',
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      email: 'sales@delta.test',
      status: 'active',
      product_count: 0,
    });
    supplier = r.body.data.id as string;
    expect((await admin.post('/suppliers').send({ name: 'x', email: 'not-an-email' })).status).toBe(
      422,
    );
    expect((await admin.post('/suppliers').send({ name: '' })).status).toBe(422);
    const other = await admin.post('/suppliers').send({ name: 'Nile Buttons' });
    const b = await (await api(ADMIN_B)).post('/suppliers').send({ name: 'B supplier' });
    supplierB = b.body.data.id as string;

    const search = await admin.get('/suppliers?search=delta');
    expect(search.body.data.map((s: { id: string }) => s.id)).toEqual([supplier]);
    expect((await admin.get('/suppliers?per_page=1')).body.meta).toMatchObject({
      total: 2,
      per_page: 1,
    });
    expect((await admin.get(`/suppliers/${supplierB}`)).status).toBe(404);
    expect((await admin.patch(`/suppliers/${supplierB}`).send({ name: 'x' })).status).toBe(404);

    const off = await admin
      .patch(`/suppliers/${other.body.data.id as string}`)
      .send({ status: 'inactive' });
    expect(off.body.data.status).toBe('inactive');
    const [entry] = await audits('SUPPLIER_UPDATED');
    expect(entry?.oldValues).toEqual({ status: 'active' });
    expect(entry?.newValues).toEqual({ status: 'inactive' });
    expect(await auditCount('SUPPLIER_CREATED')).toBe(2);
    p.inactiveSupplier = other.body.data.id as string;
  });
});

// ---------------------------------------------------------------------------
// Products — DOCUMENT 17 "Validation", FLOW 17
// ---------------------------------------------------------------------------

describe('the product catalogue', () => {
  it('creates a product with its initial stock as a manual addition, in one transaction', async () => {
    const r = await createProduct({
      name_ar: 'قماش قطن',
      name_en: 'Cotton fabric',
      sku: 'FAB-1',
      unit: 'metre',
      category_id: category,
      supplier_id: supplier,
      min_stock: '10',
      cost_price: '35.00',
      selling_price: '60.00',
      description: 'Egyptian cotton, 150 cm',
      initial_stock: { warehouse_id: w.main, quantity: '100', unit_cost: '35.00' },
    });
    expect(r.status).toBe(201);
    p.fabric = r.body.data.id as string;
    expect(r.body.data).toMatchObject({
      sku: 'FAB-1',
      min_stock: '10.000',
      cost_price: '35.00',
      selling_price: '60.00',
      total_quantity: '100.000',
      stock_value: '3500.00',
      stock_status: 'in_stock',
      category: { id: category, name_en: 'Fabrics' },
      supplier: { id: supplier, name: 'Delta Textiles' },
    });
    expect(r.body.data.stock).toEqual([
      expect.objectContaining({
        quantity: '100.000',
        average_cost: '35.00',
        stock_value: '3500.00',
      }),
    ]);
    const history = await (await api(ADMIN_A)).get(`/products/${p.fabric}/movements`);
    expect(
      history.body.data.map((m: Record<string, unknown>) => [
        m.type,
        m.quantity,
        m.unit_cost,
        m.balance_after,
      ]),
    ).toEqual([['manual_addition', '100.000', '35.00', '100.000']]);
    expect(await auditCount('PRODUCT_CREATED')).toBe(1);
    expect(await auditCount('STOCK_MOVEMENT_CREATED')).toBe(1);
  });

  it('creates a product without stock: zero everywhere, out of stock', async () => {
    const r = await createProduct({
      name_ar: 'علبة',
      name_en: 'Gift box',
      sku: 'BOX-1',
      unit: 'piece',
      cost_price: '12.50',
    });
    expect(r.status).toBe(201);
    p.box = r.body.data.id as string;
    expect(r.body.data).toMatchObject({
      min_stock: '0.000',
      selling_price: '0.00',
      total_quantity: '0.000',
      stock_value: '0.00',
      stock_status: 'out_of_stock',
      stock: [],
    });
  });

  it('SKU is unique per company, naming the product that has it; another company may reuse it', async () => {
    const dup = await createProduct({
      name_ar: 'م',
      name_en: 'Other',
      sku: 'FAB-1',
      unit: 'metre',
    });
    expect(dup.status).toBe(422);
    expect(dup.body.error.fields).toMatchObject({
      sku: ['already_taken'],
      existing_product_id: [p.fabric],
      existing_product_name_en: ['Cotton fabric'],
    });
    const b = await createProduct(
      { name_ar: 'ب', name_en: 'B fabric', sku: 'FAB-1', unit: 'metre' },
      ADMIN_B,
    );
    expect(b.status).toBe(201);
    productB = b.body.data.id as string;
    const rename = await (await api(ADMIN_A))
      .patch(`/products/${p.box as string}`)
      .send({ sku: 'FAB-1' });
    expect(rename.status).toBe(422);
    expect(rename.body.error.fields.sku).toEqual(['already_taken']);
  });

  it('validates every field and every reference, and has no quantity field at all', async () => {
    const base = { name_ar: 'م', name_en: 'P', sku: 'NEW-1', unit: 'piece' };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...base, name_en: '' }, 'name_en'],
      [{ ...base, sku: 'S'.repeat(51) }, 'sku'],
      [{ ...base, sku: '' }, 'sku'],
      [{ ...base, unit: '' }, 'unit'],
      [{ ...base, min_stock: '-1' }, 'min_stock'],
      [{ ...base, min_stock: '1.0001' }, 'min_stock'],
      [{ ...base, cost_price: '-0.01' }, 'cost_price'],
      [{ ...base, cost_price: '1.001' }, 'cost_price'],
      [{ ...base, selling_price: '-5' }, 'selling_price'],
      [{ ...base, category_id: categoryB }, 'category_id'],
      [{ ...base, supplier_id: supplierB }, 'supplier_id'],
      [{ ...base, supplier_id: p.inactiveSupplier }, 'supplier_id'],
      [{ ...base, category_id: generateId() }, 'category_id'],
      [{ ...base, quantity: '50' }, 'quantity'],
      [
        { ...base, initial_stock: { warehouse_id: warehouseB, quantity: '5' } },
        'initial_stock.warehouse_id',
      ],
      [
        { ...base, initial_stock: { warehouse_id: w.main, quantity: '0' } },
        'initial_stock.quantity',
      ],
    ];
    for (const [body, field] of cases) {
      const r = await createProduct(body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(JSON.stringify(r.body.error.fields), JSON.stringify(body)).toContain(field);
    }
    const admin = await api(ADMIN_A);
    expect(
      (await admin.patch(`/products/${p.fabric as string}`).send({ quantity: '999' })).status,
    ).toBe(422);
    expect(
      (await admin.patch(`/products/${p.fabric as string}/quantity`).send({ quantity: '999' }))
        .status,
    ).toBe(404);
    expect(await productTotal(p.fabric as string)).toBe('100.000');
  });

  it('lists with filters, search, sort and pagination', async () => {
    const admin = await api(ADMIN_A);
    const ids = async (query: string) =>
      (await admin.get(`/products${query}`)).body.data.map((x: { sku: string }) => x.sku);
    expect((await admin.get('/products?per_page=1')).body.meta).toMatchObject({
      total: 2,
      per_page: 1,
    });
    expect(await ids(`?category_id=${category}`)).toEqual(['FAB-1']);
    expect(await ids(`?supplier_id=${supplier}`)).toEqual(['FAB-1']);
    expect(await ids(`?warehouse_id=${w.main}`)).toEqual(['FAB-1']);
    expect(await ids('?stock_status=out_of_stock')).toEqual(['BOX-1']);
    expect(await ids('?search=cOtToN')).toEqual(['FAB-1']);
    expect(await ids('?search=box-')).toEqual(['BOX-1']);
    expect(await ids('?sort=sku&order=desc')).toEqual(['FAB-1', 'BOX-1']);
    expect(await ids('?sort=total_quantity')).toEqual(['BOX-1', 'FAB-1']);
    expect((await admin.get('/products?sort=price')).status).toBe(422);
    expect((await admin.get('/products?stock_status=bad')).status).toBe(422);
  });

  it('another company’s product is 404 everywhere', async () => {
    const admin = await api(ADMIN_A);
    for (const path of [
      `/products/${productB}`,
      `/products/${productB}/stock`,
      `/products/${productB}/movements`,
    ]) {
      expect((await admin.get(path)).status, path).toBe(404);
    }
    expect((await admin.patch(`/products/${productB}`).send({ name_en: 'x' })).status).toBe(404);
  });

  it('edits are audited with only what changed', async () => {
    const r = await (await api(ADMIN_A)).patch(`/products/${p.box as string}`).send({
      name_en: 'Gift box (large)',
      selling_price: '25.00',
      unit: 'piece',
    });
    expect(r.status).toBe(200);
    const [entry] = await audits('PRODUCT_UPDATED');
    expect(entry?.oldValues).toEqual({ name_en: 'Gift box', selling_price: '0.00' });
    expect(entry?.newValues).toEqual({ name_en: 'Gift box (large)', selling_price: '25.00' });
  });
});

// ---------------------------------------------------------------------------
// Every movement type, exact balance_after, weighted average (OD-13 A)
// ---------------------------------------------------------------------------

describe('every movement type, with exact balances and weighted-average valuation', () => {
  it('records each type with the sign, cost and balance_after it must have', async () => {
    const steps: [Record<string, unknown>, string, string, string, string][] = [
      // body, quantity, unit_cost, balance_after, average after
      // (100 × 35 + 50 × 41) ÷ 150 = 5550 ÷ 150 = 37.00
      [
        { type: 'purchase', quantity: '50', unit_cost: '41.00' },
        '50.000',
        '41.00',
        '150.000',
        '37.00',
      ],
      [{ type: 'sale', quantity: '30' }, '-30.000', '37.00', '120.000', '37.00'],
      // A return without a cost comes back at the location's average.
      [{ type: 'return', quantity: '5' }, '5.000', '37.00', '125.000', '37.00'],
      [
        { type: 'damage', quantity: '2', reason: 'Water damage' },
        '-2.000',
        '37.00',
        '123.000',
        '37.00',
      ],
      [{ type: 'manual_removal', quantity: '3' }, '-3.000', '37.00', '120.000', '37.00'],
      [
        { type: 'adjustment', quantity: '-0.5', reason: 'Count correction' },
        '-0.500',
        '37.00',
        '119.500',
        '37.00',
      ],
      [
        { type: 'adjustment', quantity: '1.25', reason: 'Found on recount' },
        '1.250',
        '37.00',
        '120.750',
        '37.00',
      ],
      // (120.75 × 37 + 9.25 × 40) ÷ 130 = 4837.75 ÷ 130 = 37.2134… → 37.21
      [
        { type: 'manual_addition', quantity: '9.25', unit_cost: '40.00' },
        '9.250',
        '40.00',
        '130.000',
        '37.21',
      ],
    ];
    for (const [body, qty, cost, after, avg] of steps) {
      const r = await move({ product_id: p.fabric, warehouse_id: w.main, ...body });
      expect(r.status, JSON.stringify(body)).toBe(201);
      expect(r.body.data, JSON.stringify(body)).toMatchObject({
        type: body.type,
        quantity: qty,
        unit_cost: cost,
        balance_after: after,
        negative_stock: false,
      });
      expect(await balance(p.fabric as string, w.main as string)).toEqual({
        quantity: after,
        average_cost: avg,
      });
    }
    expect(await auditCount('STOCK_MOVEMENT_CREATED')).toBe(9);
    const [audit] = (await audits('STOCK_MOVEMENT_CREATED')).filter(
      (a) => (a.newValues as { type: string }).type === 'damage',
    );
    expect(audit?.newValues).toMatchObject({
      quantity: '-2.000',
      balance_before: '125.000',
      balance_after: '123.000',
      reason: 'Water damage',
    });
  });

  it('a cost-price change affects only later movements; history keeps its unit costs', async () => {
    const costsBefore = (
      await (await api(ADMIN_A)).get(`/products/${p.fabric as string}/movements?per_page=100`)
    ).body.data.map((m: { unit_cost: string }) => m.unit_cost);
    expect(
      (
        await (await api(ADMIN_A))
          .patch(`/products/${p.fabric as string}`)
          .send({ cost_price: '50.00' })
      ).status,
    ).toBe(200);
    const costsAfter = (
      await (await api(ADMIN_A)).get(`/products/${p.fabric as string}/movements?per_page=100`)
    ).body.data.map((m: { unit_cost: string }) => m.unit_cost);
    expect(costsAfter).toEqual(costsBefore);
    // New stock at an empty location, no cost sent: the (new) cost price.
    const r = await move({
      product_id: p.fabric,
      warehouse_id: w.branch,
      type: 'manual_addition',
      quantity: '5',
    });
    expect(r.body.data).toMatchObject({ unit_cost: '50.00', balance_after: '5.000' });
    expect(await balance(p.fabric as string, w.branch as string)).toEqual({
      quantity: '5.000',
      average_cost: '50.00',
    });
    // The main location's average is untouched by the price change.
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '130.000',
      average_cost: '37.21',
    });
  });

  it('a transfer still runs through the Phase 13 service and carries the source average', async () => {
    const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.branch,
      lines: [{ product_id: p.fabric, quantity: '10' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.data.lines[0]).toMatchObject({
      unit_cost: '37.21',
      source_balance_after: '120.000',
      destination_balance_after: '15.000',
    });
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '120.000',
      average_cost: '37.21',
    });
    // (5 × 50 + 10 × 37.21) ÷ 15 = 622.10 ÷ 15 = 41.4733… → 41.47
    expect(await balance(p.fabric as string, w.branch as string)).toEqual({
      quantity: '15.000',
      average_cost: '41.47',
    });
  });

  it('inventory value is Σ quantity × average cost over locations — never the selling price', async () => {
    const product = (await (await api(ADMIN_A)).get(`/products/${p.fabric as string}`)).body.data;
    // 120 × 37.21 + 15 × 41.47 = 4465.20 + 622.05
    expect(product).toMatchObject({
      total_quantity: '135.000',
      stock_value: '5087.25',
      selling_price: '60.00',
    });
    expect(
      product.stock.map((s: Record<string, unknown>) => [
        s.quantity,
        s.average_cost,
        s.stock_value,
      ]),
    ).toEqual([
      ['120.000', '37.21', '4465.20'],
      ['15.000', '41.47', '622.05'],
    ]);
    const stock = (await (await api(ADMIN_A)).get(`/products/${p.fabric as string}/stock`)).body
      .data;
    expect(stock).toEqual(product.stock);
    const dashboard = (await (await api(ADMIN_A)).get('/warehouses/dashboard')).body.data;
    expect(dashboard.kpis).toMatchObject({
      total_products: 2,
      total_stock_units: '135.000',
      total_inventory_value: '5087.25',
      low_stock_count: 0,
      out_of_stock_count: 1,
    });
    expect(dashboard.deferred).toEqual([]);
    expect(
      dashboard.low_stock.map((row: { product: { sku: string }; stock_status: string }) => [
        row.product.sku,
        row.stock_status,
      ]),
    ).toEqual([['BOX-1', 'out_of_stock']]);
  });

  it('the ledger is readable by type and location, newest first', async () => {
    const admin = await api(ADMIN_A);
    const purchases = await admin.get(
      `/stock-movements?type=purchase&product_id=${p.fabric as string}`,
    );
    expect(purchases.body.meta.total).toBe(1);
    const branch = await admin.get(
      `/products/${p.fabric as string}/movements?warehouse_id=${w.branch as string}`,
    );
    expect(branch.body.data.map((m: { type: string }) => m.type)).toEqual([
      'transfer_in',
      'manual_addition',
    ]);
    const one = await admin.get(`/stock-movements/${branch.body.data[0].id as string}`);
    expect(one.body.data).toMatchObject({ type: 'transfer_in', balance_after: '15.000' });
  });
});

// ---------------------------------------------------------------------------
// Validation — DOCUMENT 17 "Validation"
// ---------------------------------------------------------------------------

describe('movement validation', () => {
  it('refuses every invalid movement before anything is written', async () => {
    const before = await snapshot();
    const base = { product_id: p.fabric, warehouse_id: w.main };
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...base, type: 'adjustment', quantity: '1' }, 422, 'reason'],
      [{ ...base, type: 'damage', quantity: '1' }, 422, 'reason'],
      [{ ...base, type: 'purchase', quantity: '1' }, 422, 'unit_cost'],
      [{ ...base, type: 'sale', quantity: '1', unit_cost: '9.00' }, 422, 'not_allowed'],
      [{ ...base, type: 'transfer_in', quantity: '1', unit_cost: '1.00' }, 422, 'use_transfer'],
      [{ ...base, type: 'transfer_out', quantity: '1' }, 422, 'use_transfer'],
      [{ ...base, type: 'manual_addition', quantity: '0' }, 422, 'quantity'],
      [{ ...base, type: 'sale', quantity: '-1' }, 422, 'quantity'],
      [{ ...base, type: 'sale', quantity: '1.0001' }, 422, 'quantity'],
      [{ ...base, type: 'sale', quantity: 1 }, 422, 'quantity'],
      [{ ...base, type: 'teleport', quantity: '1' }, 422, 'type'],
      [{ ...base, type: 'sale', quantity: '1', balance_after: '5' }, 422, 'balance_after'],
      [{ ...base, warehouse_id: warehouseB, type: 'sale', quantity: '1' }, 422, 'not_found'],
      [{ ...base, product_id: productB, type: 'sale', quantity: '1' }, 422, 'not_found'],
      [{ ...base, product_id: generateId(), type: 'sale', quantity: '1' }, 422, 'not_found'],
    ];
    for (const [body, status, issue] of cases) {
      const r = await move(body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(JSON.stringify(r.body.error), JSON.stringify(body)).toContain(issue);
    }
    // An inactive location takes no movement.
    await (await api(ADMIN_A)).patch(`/warehouses/${w.store as string}`).send({ is_active: false });
    const inactive = await move({
      ...base,
      warehouse_id: w.store,
      type: 'manual_addition',
      quantity: '1',
    });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('WAREHOUSE_INACTIVE');
    // Idempotency-Key is required on movement creation.
    const keyless = await (await api(ADMIN_A))
      .post('/stock-movements')
      .send({ ...base, type: 'manual_addition', quantity: '1' });
    expect(keyless.status).toBe(422);
    expect(keyless.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const after = await snapshot();
    expect({ ...after, audits: 0 }).toEqual({ ...before, audits: 0 });
    expect(after.audits).toBe(before.audits + 1); // only the warehouse deactivation
  });

  it('insufficient stock names what is available (negative stock off by default)', async () => {
    const r = await move({
      product_id: p.fabric,
      warehouse_id: w.main,
      type: 'sale',
      quantity: '200',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
    expect(r.body.error.fields).toMatchObject({ available: ['120.000'], requested: ['200.000'] });
  });
});

// ---------------------------------------------------------------------------
// Idempotency — DOCUMENT 08 §8
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('the same key twice at once creates one movement; a later replay returns it too', async () => {
    const before = await snapshot();
    const body = { product_id: p.fabric, warehouse_id: w.main, type: 'sale', quantity: '4' };
    const [a, b] = await Promise.all([move(body, 'sale-42'), move(body, 'sale-42')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    const again = await move(body, 'sale-42');
    expect(again.body.data.id).toBe(a.body.data.id);
    expect((await snapshot()).movements).toBe(before.movements + 1);
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '116.000',
      average_cost: '37.21',
    });
  });

  it('the same key with a different request is refused', async () => {
    const r = await move(
      { product_id: p.fabric, warehouse_id: w.main, type: 'sale', quantity: '5' },
      'sale-42',
    );
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '116.000',
      average_cost: '37.21',
    });
  });
});

// ---------------------------------------------------------------------------
// Negative stock — DOCUMENT 17 rule 5, FLOW 18
// ---------------------------------------------------------------------------

describe('negative stock, a company setting (default off)', () => {
  it('off: an outbound movement beyond the balance is blocked with the available figure', async () => {
    const created = await createProduct({
      name_ar: 'ملح',
      name_en: 'Salt',
      sku: 'SALT-1',
      unit: 'kg',
      initial_stock: { warehouse_id: w.main, quantity: '5', unit_cost: '10.00' },
    });
    p.salt = created.body.data.id as string;
    expect((await (await api(ADMIN_A)).get('/company')).body.data.allow_negative_stock).toBe(false);
    const r = await move({ product_id: p.salt, warehouse_id: w.main, type: 'sale', quantity: '8' });
    expect(r.status).toBe(422);
    expect(r.body.error.fields).toMatchObject({ available: ['5.000'], requested: ['8.000'] });
  });

  it('on: the movement is warned first, then recorded with its negative balance once acknowledged', async () => {
    const setting = await (await api(ADMIN_A))
      .patch('/company')
      .send({ allow_negative_stock: true });
    expect(setting.body.data.allow_negative_stock).toBe(true);
    const [changed] = await audits('SETTINGS_COMPANY_UPDATED');
    expect(changed?.newValues).toEqual({ allow_negative_stock: true });

    const before = await snapshot();
    const warned = await move({
      product_id: p.salt,
      warehouse_id: w.main,
      type: 'sale',
      quantity: '8',
    });
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('STOCK_NEGATIVE_WARNING');
    expect(warned.body.error.fields).toMatchObject({
      available: ['5.000'],
      requested: ['8.000'],
      resulting_balance: ['-3.000'],
    });
    expect((await snapshot()).movements).toBe(before.movements);

    sink.take();
    const ok = await move({
      product_id: p.salt,
      warehouse_id: w.main,
      type: 'sale',
      quantity: '8',
      acknowledge_negative_stock: true,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({
      balance_after: '-3.000',
      negative_stock: true,
      unit_cost: '10.00',
    });
    expect(await balance(p.salt as string, w.main as string)).toEqual({
      quantity: '-3.000',
      average_cost: '10.00',
    });
    const audit = (await audits('STOCK_MOVEMENT_CREATED')).find(
      (a) => a.entityId === ok.body.data.id,
    );
    expect(audit?.newValues).toMatchObject({
      negative_stock: true,
      balance_before: '5.000',
      balance_after: '-3.000',
    });
    expect(
      sink
        .take()
        .map((e) => e.type)
        .sort(),
    ).toEqual(['negative_stock', 'out_of_stock']);
  });

  it('a transfer is never allowed to go negative', async () => {
    const r = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.branch,
      lines: [{ product_id: p.salt, quantity: '1' }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
  });

  it('stock arriving at a negative balance takes its own cost as the average', async () => {
    const r = await move({
      product_id: p.salt,
      warehouse_id: w.main,
      type: 'purchase',
      quantity: '4',
      unit_cost: '12.00',
    });
    expect(r.body.data).toMatchObject({ balance_after: '1.000', negative_stock: false });
    expect(await balance(p.salt as string, w.main as string)).toEqual({
      quantity: '1.000',
      average_cost: '12.00',
    });
  });

  it('off again: blocked again', async () => {
    await (await api(ADMIN_A)).patch('/company').send({ allow_negative_stock: false });
    const r = await move({
      product_id: p.salt,
      warehouse_id: w.main,
      type: 'sale',
      quantity: '2',
      acknowledge_negative_stock: true,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STOCK_INSUFFICIENT');
  });
});

// ---------------------------------------------------------------------------
// Low / out of stock — DOCUMENT 17 rules 7–8, DOCUMENT 19 rule 3
// ---------------------------------------------------------------------------

describe('low-stock and out-of-stock detection', () => {
  it('low stock fires once per crossing, not while it stays below; recovery arms it again; out of stock is separate', async () => {
    const created = await createProduct({
      name_ar: 'كوب',
      name_en: 'Cup',
      sku: 'CUP-1',
      unit: 'piece',
      min_stock: '10',
      initial_stock: { warehouse_id: w.main, quantity: '15', unit_cost: '2.00' },
    });
    p.cup = created.body.data.id as string;
    sink.take();
    const step = async (type: string, quantity: string, extra: Record<string, unknown> = {}) => {
      const r = await move({ product_id: p.cup, warehouse_id: w.main, type, quantity, ...extra });
      expect(r.status).toBe(201);
      return sink.take().map((e) => e.type);
    };
    expect(await step('sale', '6')).toEqual(['low_stock']); // 15 → 9
    expect(await step('sale', '1')).toEqual([]); // 9 → 8, still below
    expect(await step('purchase', '5', { unit_cost: '2.00' })).toEqual([]); // 8 → 13, recovered
    expect(await step('sale', '3')).toEqual(['low_stock']); // 13 → 10, crosses again (≤ min)
    expect(await step('sale', '10')).toEqual(['out_of_stock']); // 10 → 0
    const alerts = await (await api(ADMIN_A)).get('/inventory/alerts');
    expect(
      alerts.body.data.map((a: { product: { sku: string }; alert: string }) => [
        a.product.sku,
        a.alert,
      ]),
    ).toEqual([
      ['BOX-1', 'out_of_stock'],
      ['CUP-1', 'out_of_stock'],
    ]);
    expect(await step('purchase', '4', { unit_cost: '2.00' })).toEqual([]); // 0 → 4, low (no downward crossing)
    const low = await (await api(ADMIN_A)).get('/inventory/alerts?type=low_stock');
    // SALT-1 holds 1 with min_stock 0: in stock, so not listed.
    expect(low.body.data.map((a: { product: { sku: string } }) => a.product.sku)).toEqual([
      'CUP-1',
    ]);
    // A transfer never crosses: the product total does not change.
    const t = await (await api(ADMIN_A)).post('/warehouses/transfers').send({
      source_warehouse_id: w.main,
      destination_warehouse_id: w.branch,
      lines: [{ product_id: p.cup, quantity: '4' }],
    });
    expect(t.status).toBe(201);
    expect(sink.take()).toEqual([]);
    const dashboard = (await (await api(ADMIN_A)).get('/warehouses/dashboard')).body.data;
    expect(dashboard.kpis).toMatchObject({
      total_products: 4,
      low_stock_count: 1,
      out_of_stock_count: 1,
    });
    expect(dashboard.low_stock.map((row: { product: { sku: string } }) => row.product.sku)).toEqual(
      ['BOX-1', 'CUP-1'],
    );
  });
});

// ---------------------------------------------------------------------------
// Atomicity — DOCUMENT 06 §8: "a partial write … is a defect"
// ---------------------------------------------------------------------------

describe('a movement completes fully or not at all', () => {
  const sale = () =>
    move({ product_id: p.fabric, warehouse_id: w.main, type: 'sale', quantity: '1' });

  it('failure on the movement insert: nothing persists', async () => {
    const before = await snapshot();
    await withFailingTrigger('stock_movements', `NEW.type = 'sale'`, async () => {
      expect((await sale()).status).toBe(500);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('failure after the movement insert, at the cache update: the movement is rolled back too', async () => {
    const before = await snapshot();
    sink.take();
    await withFailingTrigger('product_stock', `TG_OP = 'UPDATE'`, async () => {
      expect((await sale()).status).toBe(500);
    });
    expect(await snapshot()).toEqual(before);
    expect(sink.take()).toEqual([]);
  });

  it('failure during the valuation update (an average-cost change): nothing persists', async () => {
    const before = await snapshot();
    await withFailingTrigger(
      'product_stock',
      `TG_OP = 'UPDATE' AND NEW.average_cost IS DISTINCT FROM OLD.average_cost`,
      async () => {
        const r = await move({
          product_id: p.fabric,
          warehouse_id: w.main,
          type: 'purchase',
          quantity: '10',
          unit_cost: '99.00',
        });
        expect(r.status).toBe(500);
      },
    );
    expect(await snapshot()).toEqual(before);
  });

  it('failure writing a new product’s initial stock: the product is not created either', async () => {
    const before = await snapshot();
    await withFailingTrigger('stock_movements', `NEW.type = 'manual_addition'`, async () => {
      const r = await createProduct({
        name_ar: 'م',
        name_en: 'Doomed',
        sku: 'DOOM-1',
        unit: 'piece',
        initial_stock: { warehouse_id: w.main, quantity: '1', unit_cost: '1.00' },
      });
      expect(r.status).toBe(500);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('an audit write failing after commit does not undo the movement; the entry goes to the retry queue', async () => {
    retryQueue.entries.splice(0);
    const before = await snapshot();
    let id = '';
    await withFailingTrigger('audit_logs', 'true', async () => {
      const r = await sale();
      expect(r.status).toBe(201);
      id = r.body.data.id as string;
    });
    const after = await snapshot();
    expect(after.movements).toBe(before.movements + 1);
    expect(after.audits).toBe(before.audits);
    expect(retryQueue.entries.map((e) => [e.action, e.entityId])).toEqual([
      ['STOCK_MOVEMENT_CREATED', id],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency — DOCUMENT 17 "Concurrent movements on the same product"
// ---------------------------------------------------------------------------

describe('concurrent movements serialize: no lost update', () => {
  it('simultaneous outbound movements: exactly as many succeed as the stock allows', async () => {
    const created = await createProduct({
      name_ar: 'قدر',
      name_en: 'Pan',
      sku: 'PAN-1',
      unit: 'piece',
      initial_stock: { warehouse_id: w.main, quantity: '10', unit_cost: '5.00' },
    });
    p.pan = created.body.data.id as string;
    const sell = (qty: string) =>
      move({ product_id: p.pan, warehouse_id: w.main, type: 'sale', quantity: qty });
    const pair = await Promise.all([sell('7'), sell('7')]);
    expect(pair.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await balance(p.pan as string, w.main as string)).toEqual({
      quantity: '3.000',
      average_cost: '5.00',
    });
    const five = await Promise.all(Array.from({ length: 5 }, () => sell('1')));
    expect(five.filter((r) => r.status === 201)).toHaveLength(3);
    expect(five.filter((r) => r.status === 422)).toHaveLength(2);
    expect(await balance(p.pan as string, w.main as string)).toEqual({
      quantity: '0.000',
      average_cost: '5.00',
    });
  });

  it('simultaneous inbound movements: both land, the average is the exact weighted result', async () => {
    const buy = (cost: string) =>
      move({
        product_id: p.pan,
        warehouse_id: w.main,
        type: 'purchase',
        quantity: '5',
        unit_cost: cost,
      });
    const results = await Promise.all([buy('6.00'), buy('8.00')]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    // Either order: the first sets 6 or 8 on an empty balance; (5 × 6 + 5 × 8) ÷ 10 = 7.00.
    expect(await balance(p.pan as string, w.main as string)).toEqual({
      quantity: '10.000',
      average_cost: '7.00',
    });
  });

  it('inbound and outbound on the same stock: the result is exactly one of the two serial orders', async () => {
    const [purchase, sale] = await Promise.all([
      move({
        product_id: p.pan,
        warehouse_id: w.main,
        type: 'purchase',
        quantity: '5',
        unit_cost: '7.00',
      }),
      move({ product_id: p.pan, warehouse_id: w.main, type: 'sale', quantity: '12' }),
    ]);
    expect(purchase?.status).toBe(201);
    expect([201, 422]).toContain(sale?.status);
    const expected = sale?.status === 201 ? '3.000' : '15.000';
    expect(await balance(p.pan as string, w.main as string)).toEqual({
      quantity: expected,
      average_cost: '7.00',
    });
    await cacheMatchesLedger();
  });
});

// ---------------------------------------------------------------------------
// Deactivation, history and the product image
// ---------------------------------------------------------------------------

describe('a deactivated product keeps its stock and history but takes no movement', () => {
  it('deactivates (audited product.deactivated), refuses movements and transfers, reactivates', async () => {
    const admin = await api(ADMIN_A);
    const off = await admin.patch(`/products/${p.cup as string}`).send({ status: 'discontinued' });
    expect(off.body.data).toMatchObject({ status: 'discontinued', total_quantity: '4.000' });
    expect(await auditCount('PRODUCT_DEACTIVATED')).toBe(1);
    const r = await move({
      product_id: p.cup,
      warehouse_id: w.branch,
      type: 'sale',
      quantity: '1',
    });
    expect(r.status).toBe(422);
    expect(r.body.error.fields).toEqual({ product_id: ['not_active'] });
    const t = await admin.post('/warehouses/transfers').send({
      source_warehouse_id: w.branch,
      destination_warehouse_id: w.main,
      lines: [{ product_id: p.cup, quantity: '1' }],
    });
    expect(t.status).toBe(422);
    expect(t.body.error.fields).toEqual({ 'lines.0.product_id': ['not_active'] });
    expect((await admin.get(`/products/${p.cup as string}/movements`)).body.meta.total).toBe(9); // initial + 6 movements + 2 transfer legs
    expect(
      (await admin.get('/products?status=discontinued')).body.data.map(
        (x: { sku: string }) => x.sku,
      ),
    ).toEqual(['CUP-1']);
    const on = await admin.patch(`/products/${p.cup as string}`).send({ status: 'active' });
    expect(on.body.data.status).toBe('active');
  });

  it('the product image is an attachment of the product, checked on assignment', async () => {
    redis.reset();
    const upload = await (
      await api(ADMIN_A)
    )
      .post('/attachments')
      .field('related_type', 'product')
      .field('related_id', p.fabric as string)
      .attach('file', SAMPLES.png.bytes, { filename: 'fabric.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    const imageId = upload.body.data.id as string;
    const admin = await api(ADMIN_A);
    const set = await admin
      .patch(`/products/${p.fabric as string}`)
      .send({ image_attachment_id: imageId });
    expect(set.body.data.image_attachment_id).toBe(imageId);
    const wrong = await admin
      .patch(`/products/${p.box as string}`)
      .send({ image_attachment_id: imageId });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.fields).toEqual({ image_attachment_id: ['not_found'] });
    expect((await (await api(MANAGER)).get(`/attachments/${imageId}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Immutability — DOCUMENT 17 rule 2, DOCUMENT 26 §5
// ---------------------------------------------------------------------------

describe('movements are immutable', () => {
  it('the database refuses UPDATE and DELETE for the app role and the owner', async () => {
    for (const sql of ['UPDATE stock_movements SET reason = NULL', 'DELETE FROM stock_movements']) {
      await expect(
        withTenant(prisma, COMPANY_A, (tx) => tx.$executeRawUnsafe(sql)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        asOwner(() => prisma.$transaction((tx) => tx.$executeRawUnsafe(sql))),
      ).rejects.toThrow(/immutable/);
    }
  });

  it('the API exposes no edit or delete path, and the services have no such method', async () => {
    const admin = await api(ADMIN_A);
    const id = (await admin.get('/stock-movements?per_page=1')).body.data[0].id as string;
    expect((await admin.patch(`/stock-movements/${id}`).send({ quantity: '1' })).status).toBe(404);
    expect((await admin.delete(`/stock-movements/${id}`)).status).toBe(404);
    expect((await admin.delete(`/products/${p.box as string}`)).status).toBe(404);
    expect(Object.getOwnPropertyNames(StockMovementService.prototype).sort()).toEqual([
      'apply',
      'constructor',
      'create',
      'get',
    ]);
    expect(Object.getOwnPropertyNames(StockLedgerService.prototype).sort()).toEqual([
      'constructor',
      'lock',
      'lockProducts',
      'post',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — DOCUMENT 17 rule 3, "Cache and ledger disagree"
// ---------------------------------------------------------------------------

describe('reconciliation rebuilds the cache from the ledger', () => {
  const reconcile = async (rebuild?: boolean, account: Account = ADMIN_A) =>
    (await api(account))
      .post('/inventory/reconciliation')
      .send(rebuild === undefined ? {} : { rebuild });

  it('a consistent ledger reconciles cleanly, and the run is audited', async () => {
    const before = await auditCount('STOCK_RECONCILIATION_RUN');
    const r = await reconcile();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      mode: 'check',
      mismatches: [],
      repaired: 0,
      chain_breaks: [],
    });
    expect(r.body.data.balances_checked).toBeGreaterThan(5);
    expect(await auditCount('STOCK_RECONCILIATION_RUN')).toBe(before + 1);
  });

  it('a deliberately corrupted cache is detected, rebuilt exactly, and a second rebuild finds nothing', async () => {
    const fabricMain = await balance(p.fabric as string, w.main as string);
    const fabricBranch = await balance(p.fabric as string, w.branch as string);
    // Corrupt the quantity with the owner's capability (the ledger trigger
    // refuses it otherwise), and the average through the app role.
    await asOwner(async () => {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE product_stock DISABLE TRIGGER product_stock_ledger',
      );
      await prisma.$executeRawUnsafe(
        `UPDATE product_stock SET quantity = 999, average_cost = 1 WHERE product_id = '${p.fabric as string}' AND warehouse_id = '${w.main as string}'`,
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE product_stock ENABLE TRIGGER product_stock_ledger',
      );
    });
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE product_stock SET average_cost = 99.99 WHERE product_id = '${p.fabric as string}' AND warehouse_id = '${w.branch as string}'`,
      ),
    );
    sink.take();
    const check = await reconcile(false);
    expect(check.body.data.mismatches).toEqual([
      expect.objectContaining({
        warehouse_id: w.main,
        cached_quantity: '999.000',
        ledger_quantity: fabricMain?.quantity,
        cached_average_cost: '1.00',
        ledger_average_cost: fabricMain?.average_cost,
        repaired: false,
      }),
      expect.objectContaining({
        warehouse_id: w.branch,
        cached_quantity: fabricBranch?.quantity,
        ledger_quantity: fabricBranch?.quantity,
        cached_average_cost: '99.99',
        ledger_average_cost: fabricBranch?.average_cost,
        repaired: false,
      }),
    ]);
    // Check mode reports only; the cache is still wrong; the alert is raised.
    expect(await balance(p.fabric as string, w.main as string)).toEqual({
      quantity: '999.000',
      average_cost: '1.00',
    });
    expect(sink.take().map((e) => e.type)).toEqual(['stock_reconciliation_mismatch']);

    const rebuild = await reconcile(true);
    expect(rebuild.body.data).toMatchObject({ mode: 'rebuild', repaired: 2 });
    expect(await balance(p.fabric as string, w.main as string)).toEqual(fabricMain);
    expect(await balance(p.fabric as string, w.branch as string)).toEqual(fabricBranch);
    await cacheMatchesLedger();

    const again = await reconcile(true);
    expect(again.body.data).toMatchObject({ mismatches: [], repaired: 0 });
    const runs = await audits('STOCK_RECONCILIATION_RUN');
    const repaired = runs.find((a) => (a.newValues as { repaired: number }).repaired === 2);
    expect(repaired?.newValues).toMatchObject({ mode: 'rebuild', mismatch_count: 2 });
  });

  it('is tenant-safe, and the daily job rebuilds as the system actor', async () => {
    await withTenant(prisma, COMPANY_A, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE product_stock SET average_cost = 0.01 WHERE product_id = '${p.pan as string}' AND warehouse_id = '${w.main as string}'`,
      ),
    );
    const b = await reconcile(true, ADMIN_B);
    expect(b.body.data).toMatchObject({ mismatches: [], repaired: 0 });
    expect(await balance(p.pan as string, w.main as string)).toMatchObject({
      average_cost: '0.01',
    });

    const results = await app.get(ReconciliationRunner).runAll();
    expect(results.get(COMPANY_A)?.repaired).toBe(1);
    expect(results.get(COMPANY_B)?.repaired).toBe(0);
    expect(await balance(p.pan as string, w.main as string)).toMatchObject({
      average_cost: '7.00',
    });
    const latest = (await audits('STOCK_RECONCILIATION_RUN')).sort(
      (x, y) => y.createdAt.getTime() - x.createdAt.getTime(),
    )[0];
    const actor = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.user.findFirst({ where: { id: latest?.userId as string } }),
    );
    expect(actor?.isSystem).toBe(true);
    await cacheMatchesLedger();
    await cacheMatchesLedger(COMPANY_B);
  });
});
