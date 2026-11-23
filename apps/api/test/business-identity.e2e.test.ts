/**
 * Business Identity end-to-end: the logo, names, colours and contact details.
 *
 * Proved over HTTP with row-level security enforced (the connection runs as
 * `ufuq_app`): only `settings.update` changes the identity; everyone in the
 * company reads it; the logo bytes are checked (unsafe SVG, wrong types and
 * oversize files refused); another company never reaches the logo; replaced
 * logos leave storage; the restaurant onboarding step applies to `food` only.
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

import { OBJECT_STORAGE } from '../src/attachments/object-storage.js';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';
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

const storage = new InMemoryObjectStorage();

const CAFE = generateId();
const OTHER = generateId();
const SHOP = generateId();

const ADMIN = { email: 'admin@cafe.test', password: 'cafe-admin-password-2026' };
const ADMIN_OTHER = { email: 'admin@other.test', password: 'other-admin-password-2026' };
const ADMIN_SHOP = { email: 'admin@shop.test', password: 'shop-admin-password-2026' };
const CASHIER = { email: 'nour@cafe.test', password: 'cashier-password-2026' };
let cashier = '';

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

/** Sunday–Thursday working, Friday and Saturday rest — as data, never code. */
function week(): unknown[] {
  return Array.from({ length: 7 }, (_, day) =>
    day <= 4
      ? { day_of_week: day, is_working_day: true, start_time: '09:00', end_time: '17:00' }
      : { day_of_week: day, is_working_day: false },
  );
}


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
  const response = await (await api(account)).post('/employees').send({
    monthly_salary: '10000.00',
    joining_date: '2026-01-05',
    send_invitation: true,
    ...body,
  });
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
        data: { id: generateId(), companyId: null, key: role.key, nameEn: role.nameEn, nameAr: role.nameAr, isSystem: true },
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
  for (const [companyId, slug, admin, medical] of [
    [CAFE, 'cafe', ADMIN, 'food'],
    [OTHER, 'other-cafe', ADMIN_OTHER, 'food'],
    [SHOP, 'shop', ADMIN_SHOP, 'retail'],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: {
          id: companyId,
          name: slug,
          slug,
          timezone: CAIRO,
          businessActivity: medical,
        },
      });
      await tx.user.create({
        data: { id: generateId(), companyId, email: admin.email, passwordHash, roleId: adminRoleId, status: 'active' },
      });
    });
  }
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

  const admin = await api(ADMIN);
  const schedule = await admin.post('/work-schedules').send({
    name: 'Clinic week',
    timezone: CAIRO,
    grace_period_minutes: 15,
    break_minutes: 60,
    half_day_threshold_hours: '4.00',
    overtime_policy: 'paid',
    is_default: true,
    days: week(),
  });
  const scheduleId = schedule.body.data.id as string;
  const hire = (first: string, account: Account, code: string): Promise<string> =>
    createEmployee(ADMIN, {
      first_name: first,
      last_name: 'Clinic',
      email: account.email,
      employee_code: code,
      role_key: 'employee',
      work_schedule_id: scheduleId,
    });
  cashier = await hire('Nour', CASHIER, 'C-1');
  await activate(CASHIER);
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});


// ---------------------------------------------------------------------------

function png(width: number, height: number, extra = 64): Buffer {
  const b = Buffer.alloc(33 + extra, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
const SAFE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><rect width="300" height="120" fill="#0B1E4B"/></svg>';
const EVIL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>fetch("/x")</script></svg>';

function brandKeys(company: string): string[] {
  return [...storage.objects.keys()].filter((k) => k.startsWith(`companies/${company}/brand/`));
}

const asBuffer = (res: request.Response): Buffer => res.body as Buffer;
const binary = (req: request.Test): request.Test =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });

describe('business identity — reading', () => {
  it('a restaurant admin is asked for the identity step; defaults to the company name', async () => {
    const res = await (await api(ADMIN)).get('/business-identity');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      company_name: 'cafe',
      activity: 'food',
      logo: null,
      print_logo: false,
      can_edit: true,
      onboarding: { applies: true, pending: true },
    });
  });

  it('another activity is not asked; an employee reads but cannot edit', async () => {
    const shop = await (await api(ADMIN_SHOP)).get('/business-identity');
    expect(shop.body.data.onboarding).toEqual({ applies: false, pending: false });
    expect(cashier).toMatch(/^[0-9a-f-]{36}$/);
    const cash = await (await api(CASHIER)).get('/business-identity');
    expect(cash.status).toBe(200);
    expect(cash.body.data).toMatchObject({ can_edit: false, onboarding: { applies: true, pending: false } });
  });
});

describe('business identity — details', () => {
  it('the admin saves names, colours and contacts', async () => {
    const res = await (await api(ADMIN)).patch('/business-identity').send({
      name_ar: 'كافيه النيل',
      name_en: 'Nile Café',
      primary_color: '#1e7aff',
      secondary_color: '#0B1E4B',
      phone: '+20 2 2345 6789',
      whatsapp: '+20 100 123 4567',
      email: 'hello@nile.test',
      instagram: 'https://instagram.com/nilecafe',
      address_ar: 'الزمالك، القاهرة',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name_ar: 'كافيه النيل', name_en: 'Nile Café', primary_color: '#1E7AFF' });
  });

  it('refuses bad values', async () => {
    const admin = await api(ADMIN);
    for (const body of [
      { primary_color: 'blue' },
      { email: 'not-an-email' },
      { website: 'javascript:alert(1)' },
      { instagram: 'ftp://x.test' },
      { phone: 'call me' },
      { name_ar: 'x'.repeat(121) },
    ]) {
      const res = await admin.patch('/business-identity').send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('an employee without settings.update cannot change anything', async () => {
    const cash = await api(CASHIER);
    expect((await cash.patch('/business-identity').send({ name_en: 'Hacked' })).status).toBe(403);
    expect((await cash.post('/business-identity/logo').attach('logo', png(400, 200), 'l.png')).status).toBe(403);
    expect((await cash.delete('/business-identity/logo')).status).toBe(403);
    expect((await cash.post('/business-identity/onboarding').send({ action: 'skip' })).status).toBe(403);
    expect(brandKeys(CAFE)).toEqual([]);
  });
});

describe('business identity — logo', () => {
  it('stores a PNG with its thermal copy under the company prefix', async () => {
    const admin = await api(ADMIN);
    const logo = png(800, 400);
    const res = await admin
      .post('/business-identity/logo')
      .field('print_logo', 'true')
      .attach('logo', logo, { filename: 'logo.png', contentType: 'image/png' })
      .attach('thermal', png(576, 288), { filename: 't.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data.logo).toEqual({ type: 'png', width: 800, height: 400, version: 1, has_thermal: true });
    expect(res.body.data.print_logo).toBe(true);
    expect(brandKeys(CAFE)).toHaveLength(2);
    const got = await binary((await api(CASHIER)).get('/business-identity/logo'));
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toContain("default-src 'none'");
    expect(asBuffer(got).equals(logo)).toBe(true);
    const thermal = await binary((await api(CASHIER)).get('/business-identity/logo?variant=thermal'));
    expect(thermal.status).toBe(200);
  });

  it('judges the file by its bytes: unsafe SVG, other types and oversize are refused', async () => {
    const admin = await api(ADMIN);
    const evil = await admin.post('/business-identity/logo').attach('logo', Buffer.from(EVIL_SVG), { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(evil.status).toBe(422);
    expect(evil.body.error.fields.logo).toEqual(['invalid']);
    const disguised = await admin.post('/business-identity/logo').attach('logo', Buffer.from('GIF89a......'), { filename: 'logo.png', contentType: 'image/png' });
    expect(disguised.status).toBe(422);
    const huge = await admin.post('/business-identity/logo').attach('logo', png(800, 400, 2 * 1024 * 1024), 'big.png');
    expect(huge.status).toBe(422);
    const badThermal = await admin
      .post('/business-identity/logo')
      .attach('logo', png(800, 400), 'l.png')
      .attach('thermal', png(1200, 300), 't.png');
    expect(badThermal.status).toBe(422);
    expect(brandKeys(CAFE)).toHaveLength(2);
  });

  it('a safe SVG replaces the PNG; the old objects leave storage; no thermal means text receipts', async () => {
    const before = brandKeys(CAFE);
    const res = await (await api(ADMIN)).post('/business-identity/logo').attach('logo', Buffer.from(SAFE_SVG), { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(res.status).toBe(200);
    expect(res.body.data.logo).toMatchObject({ type: 'svg', width: 300, height: 120, version: 2, has_thermal: false });
    expect(res.body.data.print_logo).toBe(false);
    const after = brandKeys(CAFE);
    expect(after).toHaveLength(1);
    expect(before.some((k) => after.includes(k))).toBe(false);
    const got = await binary((await api(ADMIN)).get('/business-identity/logo'));
    expect(got.headers['content-type']).toBe('image/svg+xml');
    expect(got.headers['content-security-policy']).toContain('sandbox');
  });

  it('another company never reaches this logo, and its own upload stays in its own prefix', async () => {
    const other = await api(ADMIN_OTHER);
    expect((await other.get('/business-identity/logo')).status).toBe(404);
    const mine = await other.get('/business-identity');
    expect(mine.body.data).toMatchObject({ company_name: 'other-cafe', name_ar: null, logo: null });
    await other.post('/business-identity/logo').attach('logo', png(300, 300), 'o.png');
    expect(brandKeys(OTHER)).toHaveLength(1);
    expect(brandKeys(CAFE)).toHaveLength(1);
    const cafeLogo = await binary((await api(ADMIN)).get('/business-identity/logo'));
    expect(cafeLogo.headers['content-type']).toBe('image/svg+xml');
  });

  it('removing the logo clears it and its bytes', async () => {
    const res = await (await api(ADMIN)).delete('/business-identity/logo');
    expect(res.status).toBe(200);
    expect(res.body.data.logo).toBeNull();
    expect(brandKeys(CAFE)).toEqual([]);
    expect((await (await api(ADMIN)).get('/business-identity/logo')).status).toBe(404);
  });
});

describe('business identity — onboarding and audit', () => {
  it('skipping the step stops asking; details are kept', async () => {
    const res = await (await api(ADMIN)).post('/business-identity/onboarding').send({ action: 'skip' });
    expect(res.status).toBe(200);
    expect(res.body.data.onboarding.pending).toBe(false);
    expect(res.body.data.name_en).toBe('Nile Café');
  });

  it('changes are audited', async () => {
    const rows = await withTenant(prisma, CAFE, (tx) =>
      tx.auditLog.findMany({ where: { action: { in: ['BUSINESS_IDENTITY_UPDATED', 'BUSINESS_IDENTITY_LOGO_CHANGED'] } } }),
    );
    expect(rows.filter((r) => r.action === 'BUSINESS_IDENTITY_UPDATED')).toHaveLength(1);
    expect(rows.filter((r) => r.action === 'BUSINESS_IDENTITY_LOGO_CHANGED')).toHaveLength(3);
  });
});
