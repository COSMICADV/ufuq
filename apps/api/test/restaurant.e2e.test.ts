/**
 * Business — Restaurants & Cafés, phase R1 end-to-end: branches, the team,
 * the visual menu, tables, and orders from the POS through the kitchen to
 * the waiter or the pickup counter.
 *
 * What is proved over HTTP, with row-level security enforced (the connection
 * runs as `ufuq_app`):
 *   - a company that is not a restaurant has no restaurant routes (404);
 *   - only the owner sets up branches, the menu, tables and the team;
 *   - prices are computed on the server from the menu, never from the screen;
 *   - a repeated "Confirm" returns the first order (no duplicates);
 *   - the kitchen receives each order at once (live event) and never sees prices;
 *   - "Done" sends dine-in orders to the waiter and take-away to the pickup counter;
 *   - each branch's staff see only their own branch; another company sees nothing;
 *   - only allowed status moves happen, and every move is kept in the order history.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { RestaurantEvents } from '../src/restaurant/restaurant-events.js';
import type { OrderEvent } from '../src/restaurant/restaurant-events.js';

import { allMigrationsSql } from './all-migrations.js';
import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';

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

const CAFE = generateId();
const OTHER_CAFE = generateId();
const SHOP = generateId();

interface Account {
  readonly email: string;
  readonly password: string;
}

const OWNER = { email: 'owner@cafe.test', password: 'cafe-owner-password-2026' };
const OWNER_OTHER = { email: 'owner@other.test', password: 'other-owner-password-2026' };
const OWNER_SHOP = { email: 'owner@shop.test', password: 'shop-owner-password-2026' };
const CASHIER = { email: 'cashier@cafe.test', password: 'cashier-password-2026' };
const WAITER = { email: 'waiter@cafe.test', password: 'waiter-password-2026' };
const KITCHEN = { email: 'kitchen@cafe.test', password: 'kitchen-password-2026' };
const CASHIER_B = { email: 'cashier-b@cafe.test', password: 'cashier-b-password-2026' };

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

// The smallest valid PNG large enough for the photo check (64 × 64).
function png(width = 64, height = 64): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([header, ihdr, Buffer.alloc(32)]);
}

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
  return Array.from({ length: 7 }, (_, day) => ({
    day_of_week: day,
    is_working_day: true,
    start_time: '09:00',
    end_time: '23:00',
  }));
}

function server(): Parameters<typeof request>[0] {
  return app.getHttpServer() as Parameters<typeof request>[0];
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
    if (response.status !== 200)
      throw new Error(`Login failed for ${account.email}: ${JSON.stringify(response.body)}`);
    token = response.body.data.accessToken as string;
    tokens.set(account.email, token);
  }
  return as(token);
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
  for (const [companyId, slug, admin, activity] of [
    [CAFE, 'cafe', OWNER, 'food'],
    [OTHER_CAFE, 'other-cafe', OWNER_OTHER, 'food'],
    [SHOP, 'shop', OWNER_SHOP, 'retail'],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: { id: companyId, name: slug, slug, timezone: CAIRO, businessActivity: activity },
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

let scheduleId = '';
const staff = { cashier: '', waiter: '', kitchen: '', cashierB: '' };

async function hire(first: string, account: Account, code: string): Promise<string> {
  const response = await (await api(OWNER)).post('/employees').send({
    first_name: first,
    last_name: 'Cafe',
    email: account.email,
    employee_code: code,
    role_key: 'employee',
    work_schedule_id: scheduleId,
    monthly_salary: '8000.00',
    joining_date: '2026-01-05',
    send_invitation: false,
    password: account.password,
  });
  if (response.status !== 201)
    throw new Error(`Employee create failed: ${JSON.stringify(response.body)}`);
  return response.body.data.id as string;
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
    .useValue(storage)
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

  const owner = await api(OWNER);
  const schedule = await owner.post('/work-schedules').send({
    name: 'Cafe week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 30,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  scheduleId = schedule.body.data.id as string;
  staff.cashier = await hire('Sara', CASHIER, 'C-1');
  staff.waiter = await hire('Karim', WAITER, 'W-1');
  staff.kitchen = await hire('Hassan', KITCHEN, 'K-1');
  staff.cashierB = await hire('Nour', CASHIER_B, 'C-2');
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

// ---------------------------------------------------------------------------

let branchA = '';
let branchB = '';
let table1 = '';
let burger = '';
let sizeLarge = '';
let extraCheese = '';
let noOnion = '';
let latte = '';
let dineInOrder = '';
let takeawayOrder = '';
const events: OrderEvent[] = [];

describe('restaurant — access and setup', () => {
  it('a company that is not a restaurant has no restaurant routes', async () => {
    const shop = await api(OWNER_SHOP);
    const me = await shop.get('/restaurant/me');
    expect(me.status).toBe(200);
    expect(me.body.data.enabled).toBe(false);
    expect((await shop.get('/restaurant/branches')).status).toBe(404);
    expect((await shop.post('/restaurant/branches').send({ name: 'X' })).status).toBe(404);
  });

  it('the owner creates branches; names are unique; staff cannot', async () => {
    const owner = await api(OWNER);
    const a = await owner
      .post('/restaurant/branches')
      .send({ name: 'New Cairo', tax_rate: '14.00', service_rate: '12.00' });
    expect(a.status).toBe(201);
    branchA =
      (a.body.data as { id: string; name: string }[]).find((b) => b.name === 'New Cairo')?.id ?? '';
    const b = await owner
      .post('/restaurant/branches')
      .send({ name: 'Nasr City', address: 'Abbas El Akkad' });
    branchB =
      (b.body.data as { id: string; name: string }[]).find((x) => x.name === 'Nasr City')?.id ?? '';
    expect(branchA).not.toBe('');
    expect(branchB).not.toBe('');
    const dup = await owner.post('/restaurant/branches').send({ name: 'new cairo' });
    expect(dup.status).toBe(422);
    expect(dup.body.error.fields.name).toContain('already_taken');
    // An employee not on the team has no restaurant access at all.
    const cashier = await api(CASHIER);
    expect((await cashier.post('/restaurant/branches').send({ name: 'Mine' })).status).toBe(403);
    expect((await cashier.get('/restaurant/menu')).status).toBe(403);
  });

  it('the owner puts each employee in one branch with one role and a shift', async () => {
    const owner = await api(OWNER);
    const put = (id: string, branch: string, role: string) =>
      owner.put(`/restaurant/staff/${id}`).send({
        branch_id: branch,
        role,
        job_title: role,
        working_days: [6, 7, 1, 2, 3],
        shift_start: '10:00',
        shift_end: '18:00',
        break_minutes: 30,
      });
    expect((await put(staff.cashier, branchA, 'cashier')).status).toBe(200);
    expect((await put(staff.waiter, branchA, 'waiter')).status).toBe(200);
    expect((await put(staff.kitchen, branchA, 'kitchen')).status).toBe(200);
    const last = await put(staff.cashierB, branchB, 'cashier');
    expect(last.status).toBe(200);
    const sara = (
      last.body.data as { employee_id: string; restaurant: { weekly_minutes: number } | null }[]
    ).find((s) => s.employee_id === staff.cashier);
    expect(sara?.restaurant?.weekly_minutes).toBe(5 * 450);
    const bad = await owner
      .put(`/restaurant/staff/${staff.cashier}`)
      .send({ branch_id: branchA, role: 'chef', working_days: [] });
    expect(bad.status).toBe(422);
    // Staff cannot change the team.
    expect(
      (
        await (await api(CASHIER))
          .put(`/restaurant/staff/${staff.waiter}`)
          .send({ branch_id: branchA, role: 'cashier', working_days: [] })
      ).status,
    ).toBe(403);

    const me = await (await api(KITCHEN)).get('/restaurant/me');
    expect(me.body.data.role).toBe('kitchen');
    expect(me.body.data.branch.id).toBe(branchA);
    expect(me.body.data.actions).toEqual(['kitchen.view', 'kitchen.update']);
  });

  it('the owner adds tables with a default waiter', async () => {
    const owner = await api(OWNER);
    const t = await owner
      .post('/restaurant/tables')
      .send({ branch_id: branchA, label: 'T1', seats: 4, default_waiter_id: staff.waiter });
    expect(t.status).toBe(201);
    table1 =
      (t.body.data as { id: string; label: string }[]).find((x) => x.label === 'T1')?.id ?? '';
    await owner.post('/restaurant/tables').send({ branch_id: branchA, label: 'T2' });
    // A waiter of another branch cannot be a default waiter here.
    const wrong = await owner
      .post('/restaurant/tables')
      .send({ branch_id: branchB, label: 'B1', default_waiter_id: staff.waiter });
    expect(wrong.status).toBe(422);
    const listed = await (await api(WAITER)).get('/restaurant/tables');
    expect(listed.status).toBe(200);
    expect((listed.body.data as unknown[]).length).toBe(2);
    // Branch B's cashier sees only branch B, and naming branch A is a 404.
    const b = await api(CASHIER_B);
    expect((await b.get('/restaurant/tables')).body.data).toEqual([]);
    expect((await b.get(`/restaurant/tables?branch_id=${branchA}`)).status).toBe(404);
  });

  it('the owner builds the visual menu: categories, sizes, extras, photo', async () => {
    const owner = await api(OWNER);
    const cat = await owner.post('/restaurant/menu/categories').send({ name: 'Burgers' });
    expect(cat.status).toBe(201);
    const burgers = (cat.body.data.categories as { id: string; name: string }[])[0]?.id ?? '';
    const drinks = await owner.post('/restaurant/menu/categories').send({ name: 'Coffee' });
    const coffee =
      (drinks.body.data.categories as { id: string; name: string }[]).find(
        (c) => c.name === 'Coffee',
      )?.id ?? '';
    const item = await owner.post('/restaurant/menu/items').send({
      category_id: burgers,
      name: 'Classic burger',
      description: 'Beef, lettuce, tomato',
      price: '0.00',
      recipe: '180 g beef patty',
      sizes: [
        { name: 'Single', price: '120.00' },
        { name: 'Double', price: '170.00' },
      ],
      options: [
        { kind: 'extra', name: 'Cheese', price: '15.00' },
        { kind: 'customization', name: 'No onion', price: '0.00' },
      ],
    });
    expect(item.status).toBe(201);
    burger = item.body.data.id as string;
    sizeLarge =
      (item.body.data.sizes as { id: string; name: string }[]).find((s) => s.name === 'Double')
        ?.id ?? '';
    extraCheese =
      (item.body.data.options as { id: string; name: string }[]).find((o) => o.name === 'Cheese')
        ?.id ?? '';
    noOnion =
      (item.body.data.options as { id: string; name: string }[]).find((o) => o.name === 'No onion')
        ?.id ?? '';
    const l = await owner
      .post('/restaurant/menu/items')
      .send({ category_id: coffee, name: 'Latte', price: '65.00' });
    latte = l.body.data.id as string;

    const photo = await owner
      .post(`/restaurant/menu/items/${burger}/image`)
      .attach('image', png(), { filename: 'b.png', contentType: 'image/png' });
    expect(photo.status).toBe(200);
    expect(photo.body.data.image_version).toBe(1);
    const svg = await owner
      .post(`/restaurant/menu/items/${latte}/image`)
      .attach('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), {
        filename: 'x.svg',
        contentType: 'image/svg+xml',
      });
    expect(svg.status).toBe(422);

    // The cashier reads the menu (and the photo), without the recipe.
    const cashier = await api(CASHIER);
    const menu = await cashier.get('/restaurant/menu');
    expect(menu.status).toBe(200);
    const seen = (menu.body.data.items as { id: string; recipe?: string }[]).find(
      (i) => i.id === burger,
    );
    expect(seen).toBeDefined();
    expect(seen && 'recipe' in seen).toBe(false);
    const img = await cashier.get(`/restaurant/menu/items/${burger}/image?v=1`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    // The kitchen does not read the menu, and nobody but the owner changes it.
    expect((await (await api(KITCHEN)).get('/restaurant/menu')).status).toBe(403);
    expect(
      (await cashier.patch(`/restaurant/menu/items/${burger}`).send({ price: '1.00' })).status,
    ).toBe(403);
  });
});

describe('restaurant — orders through the kitchen', () => {
  it('the cashier confirms a dine-in order; the server prices it; the kitchen hears it at once', async () => {
    app.get(RestaurantEvents).subscribe(CAFE, (event) => events.push(event));
    const cashier = await api(CASHIER);
    const body = {
      client_key: 'order-key-0001',
      type: 'dine_in',
      table_id: table1,
      notes: 'Birthday',
      items: [
        {
          menu_item_id: burger,
          size_id: sizeLarge,
          option_ids: [extraCheese, noOnion],
          quantity: 2,
          notes: 'well done',
        },
        { menu_item_id: latte, quantity: 1 },
      ],
    };
    const created = await cashier.post('/restaurant/orders').send(body);
    expect(created.status).toBe(201);
    const order = created.body.data;
    dineInOrder = order.id as string;
    expect(order.number).toBe(1);
    expect(order.status).toBe('new');
    expect(order.waiter.id).toBe(staff.waiter);
    // (170 + 15) × 2 + 65 = 435; service 12% = 52.20; tax 14% of 487.20 = 68.21
    expect(order.totals).toMatchObject({
      subtotal: '435.00',
      service: '52.20',
      tax: '68.21',
      total: '555.41',
    });
    expect(
      events.some(
        (e) => e.kind === 'created' && e.order_id === dineInOrder && e.branch_id === branchA,
      ),
    ).toBe(true);

    // A second tap with the same key returns the same order.
    const again = await cashier.post('/restaurant/orders').send(body);
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(dineInOrder);
    const count = await withTenant(prisma, CAFE, (tx) => tx.restaurantOrder.count());
    expect(count).toBe(1);
  });

  it('refuses a missing size, a foreign option, and a discount above the subtotal', async () => {
    const cashier = await api(CASHIER);
    const noSize = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0002',
      type: 'takeaway',
      items: [{ menu_item_id: burger, quantity: 1 }],
    });
    expect(noSize.status).toBe(422);
    const foreign = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0003',
      type: 'takeaway',
      items: [{ menu_item_id: latte, option_ids: [extraCheese], quantity: 1 }],
    });
    expect(foreign.status).toBe(422);
    const discount = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0004',
      type: 'takeaway',
      discount: '100.00',
      items: [{ menu_item_id: latte, quantity: 1 }],
    });
    expect(discount.status).toBe(422);
    const delivery = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0005',
      type: 'delivery',
      items: [{ menu_item_id: latte, quantity: 1 }],
    });
    expect(delivery.status).toBe(422);
  });

  it('kitchen sees the order without any prices, and cannot create or cancel', async () => {
    const kitchen = await api(KITCHEN);
    const list = await kitchen.get('/restaurant/orders?view=kitchen');
    expect(list.status).toBe(200);
    const order = (list.body.data as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(order.id).toBe(dineInOrder);
    expect(order.totals).toBeUndefined();
    const line = (order.items as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(line.unit_price).toBeUndefined();
    expect(line.size_name).toBe('Double');
    expect((line.options as { name: string; price?: string }[]).map((o) => o.name)).toEqual([
      'Cheese',
      'No onion',
    ]);
    expect((line.options as { price?: string }[])[0]?.price).toBeUndefined();
    expect(line.notes).toBe('well done');
    expect(
      (
        await kitchen
          .post('/restaurant/orders')
          .send({
            client_key: 'kitchen-key-01',
            type: 'takeaway',
            items: [{ menu_item_id: latte, quantity: 1 }],
          })
      ).status,
    ).toBe(403);
    expect(
      (await kitchen.post(`/restaurant/orders/${dineInOrder}/cancel`).send({ reason: 'no' }))
        .status,
    ).toBe(403);
  });

  it('a waiter cannot skip the kitchen; the kitchen moves the order; Done reaches the waiter', async () => {
    const waiter = await api(WAITER);
    const early = await waiter
      .post(`/restaurant/orders/${dineInOrder}/status`)
      .send({ status: 'served' });
    expect(early.status).toBe(409);
    const kitchen = await api(KITCHEN);
    expect(
      (await kitchen.post(`/restaurant/orders/${dineInOrder}/status`).send({ status: 'preparing' }))
        .status,
    ).toBe(200);
    events.length = 0;
    const done = await kitchen
      .post(`/restaurant/orders/${dineInOrder}/status`)
      .send({ status: 'ready' });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('ready');
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'status',
        status: 'ready',
        type: 'dine_in',
        waiter_id: staff.waiter,
      }),
    ]);
    // The kitchen cannot hand it over itself.
    expect(
      (await kitchen.post(`/restaurant/orders/${dineInOrder}/status`).send({ status: 'served' }))
        .status,
    ).toBe(403);

    const ready = await waiter.get('/restaurant/orders?view=waiter');
    expect(
      (ready.body.data as { id: string; status: string }[]).find((o) => o.id === dineInOrder)
        ?.status,
    ).toBe('ready');
    const served = await waiter
      .post(`/restaurant/orders/${dineInOrder}/status`)
      .send({ status: 'served' });
    expect(served.status).toBe(200);
    expect(served.body.data.status).toBe('served');
    expect((served.body.data.history as { to: string }[]).map((h) => h.to)).toEqual([
      'new',
      'preparing',
      'ready',
      'served',
    ]);
    // Served is final: no further move.
    expect(
      (await kitchen.post(`/restaurant/orders/${dineInOrder}/status`).send({ status: 'preparing' }))
        .status,
    ).toBe(409);
  });

  it('a take-away order goes to the pickup counter, not to the waiter', async () => {
    const cashier = await api(CASHIER);
    const created = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0010',
      type: 'takeaway',
      customer_name: 'Ahmed',
      items: [{ menu_item_id: latte, quantity: 2 }],
    });
    expect(created.status).toBe(201);
    takeawayOrder = created.body.data.id as string;
    expect(created.body.data.number).toBe(2);
    expect(created.body.data.totals.service).toBe('0.00');
    const waiter = await api(WAITER);
    expect((await waiter.get(`/restaurant/orders/${takeawayOrder}`)).status).toBe(404);
    expect(
      ((await waiter.get('/restaurant/orders?view=waiter')).body.data as { id: string }[]).some(
        (o) => o.id === takeawayOrder,
      ),
    ).toBe(false);

    await (await api(KITCHEN))
      .post(`/restaurant/orders/${takeawayOrder}/status`)
      .send({ status: 'ready' });
    const pickup = await cashier.get('/restaurant/orders?view=pickup');
    expect(
      (pickup.body.data as { id: string; status: string }[]).find((o) => o.id === takeawayOrder)
        ?.status,
    ).toBe('ready');
    const handed = await cashier
      .post(`/restaurant/orders/${takeawayOrder}/status`)
      .send({ status: 'picked_up' });
    expect(handed.status).toBe(200);
    expect(handed.body.data.status).toBe('picked_up');
  });

  it('the cashier cancels an unfinished order with a reason; a finished one cannot be cancelled', async () => {
    const cashier = await api(CASHIER);
    const created = await cashier.post('/restaurant/orders').send({
      client_key: 'order-key-0020',
      type: 'takeaway',
      items: [{ menu_item_id: latte, quantity: 1 }],
    });
    const id = created.body.data.id as string;
    const cancelled = await cashier
      .post(`/restaurant/orders/${id}/cancel`)
      .send({ reason: 'Customer left' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancel_reason).toBe('Customer left');
    expect(
      (
        await cashier
          .post(`/restaurant/orders/${takeawayOrder}/cancel`)
          .send({ reason: 'Too late' })
      ).status,
    ).toBe(409);
  });

  it('branches and companies are isolated', async () => {
    const b = await api(CASHIER_B);
    expect((await b.get(`/restaurant/orders/${dineInOrder}`)).status).toBe(404);
    expect((await b.get('/restaurant/orders?view=active')).body.data).toEqual([]);
    expect(
      (await b.post(`/restaurant/orders/${dineInOrder}/status`).send({ status: 'served' })).status,
    ).toBe(404);
    // Branch B numbers its own orders from 1.
    const own = await b
      .post('/restaurant/orders')
      .send({
        client_key: 'order-key-b001',
        type: 'takeaway',
        items: [{ menu_item_id: latte, quantity: 1 }],
      });
    expect(own.status).toBe(201);
    expect(own.body.data.number).toBe(1);
    expect(own.body.data.branch.id).toBe(branchB);

    const other = await api(OWNER_OTHER);
    expect((await other.get(`/restaurant/orders/${dineInOrder}`)).status).toBe(404);
    expect((await other.get('/restaurant/branches')).body.data).toEqual([]);
    expect((await other.get(`/restaurant/menu/items/${burger}/image`)).status).toBe(404);
  });

  it('the owner sees every branch, history and prices; changes are audited', async () => {
    const owner = await api(OWNER);
    const history = await owner.get(`/restaurant/orders?view=history&branch_id=${branchA}`);
    expect(history.status).toBe(200);
    expect((history.body.data as { status: string }[]).map((o) => o.status).sort()).toEqual([
      'cancelled',
      'picked_up',
      'served',
    ]);
    // With two branches, the owner must say which one.
    expect((await owner.get('/restaurant/orders?view=active')).status).toBe(422);
    const audits = await withTenant(prisma, CAFE, (tx) =>
      tx.auditLog.findMany({ where: { entityType: 'restaurant_order' }, select: { action: true } }),
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('RESTAURANT_ORDER_CREATED');
    expect(actions).toContain('RESTAURANT_ORDER_STATUS_CHANGED');
    expect(actions).toContain('RESTAURANT_ORDER_CANCELLED');
  });

  it('the live stream delivers a new order to the kitchen screen', async () => {
    const http = await import('node:http');
    await api(KITCHEN);
    const token = tokens.get(KITCHEN.email) as string;
    const address = (app.getHttpServer() as { address(): { port: number } }).address();
    const received: string[] = [];
    const stream = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: address.port,
          path: `/${API_PREFIX}/restaurant/stream`,
          headers: { Authorization: `Bearer ${token}` },
        },
        resolve,
      );
      req.on('error', reject);
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => received.push(chunk));
    await new Promise((r) => setTimeout(r, 100));
    expect(received.join('')).toContain('event: ready');
    const created = await (await api(CASHIER)).post('/restaurant/orders').send({
      client_key: 'order-key-live1',
      type: 'takeaway',
      items: [{ menu_item_id: latte, quantity: 1 }],
    });
    await new Promise((r) => setTimeout(r, 100));
    const text = received.join('');
    expect(text).toContain('event: order');
    expect(text).toContain(created.body.data.id as string);
    // An event never carries prices, items or customers.
    expect(text).not.toContain('65.00');
    stream.destroy();
  });

  it('the live stream opens for a staff screen and refuses another branch', async () => {
    const b = await api(CASHIER_B);
    expect((await b.get(`/restaurant/stream?branch_id=${branchA}`)).status).toBe(404);
    expect((await (await api(OWNER_SHOP)).get('/restaurant/stream')).status).toBe(404);
  });
});
