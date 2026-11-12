/**
 * QR Studio, end to end: the studio's endpoints and the public scan page's.
 *
 * Real Nest, guards, DTO validation, the production body parsers and real
 * PostgreSQL with row-level security enforced as `ufuq_app`; Redis and the
 * object store are in-memory stand-ins.
 *
 * Actors: an ADMIN in company A, an EMPLOYEE in company A, and the ADMIN of
 * company B.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
import { registerBodyParsers } from '../src/body-parsers.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { FakeRedis } from './fake-redis.js';
import { InMemoryObjectStorage } from './in-memory-storage.js';
import { allMigrationsSql } from './all-migrations.js';

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: NestExpressApplication;
let prisma: PrismaClient;

const redis = new FakeRedis();
const storage = new InMemoryObjectStorage();
const mail: MailTransport = {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  },
};

const COMPANY_A = generateId();
const COMPANY_B = generateId();
const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const EMPLOYEE_A = { email: 'worker@a.test', password: 'worker-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };
const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

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
      maxUploadBytes: 1024 * 1024,
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
  const users = [
    [COMPANY_A, 'company-a', ADMIN_A, 'admin'],
    [COMPANY_A, 'company-a', EMPLOYEE_A, 'employee'],
    [COMPANY_B, 'company-b', ADMIN_B, 'admin'],
  ] as const;
  const created = new Set<string>();
  for (const [companyId, slug, account, role] of users) {
    const passwordHash = await hashPassword(account.password);
    await withTenant(prisma, companyId, async (tx) => {
      if (!created.has(companyId)) {
        await tx.company.create({
          data: { id: companyId, name: slug, slug, timezone: 'Africa/Cairo' },
        });
        created.add(companyId);
      }
      await tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: account.email,
          passwordHash,
          roleId: roleIdByKey.get(role) as string,
          status: 'active',
        },
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

  app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  registerBodyParsers(app);
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  app.use(cookieParser());
  await app.listen(0, '127.0.0.1');

  prisma = app.get<PrismaClient>(PRISMA_CLIENT);
  await seedFixtures();
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

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
    if (response.status !== 200) throw new Error(`Login failed: ${JSON.stringify(response.body)}`);
    token = response.body.data.accessToken as string;
    tokens.set(account.email, token);
  }
  const bearer = `Bearer ${token}`;
  const agent = request(server());
  return {
    get: (path: string) => agent.get(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    post: (path: string) => agent.post(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    put: (path: string) => agent.put(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    delete: (path: string) => agent.delete(`/${API_PREFIX}${path}`).set('Authorization', bearer),
  };
}

const visitor = () => request(server());
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

function menu(name: string): Record<string, unknown> {
  return {
    id: 'ignored',
    name,
    type: 'menu',
    data: { items: 'Tea | 20' },
    page: { title: name, bg: '#3b2fd9' },
    design: { dots: 'rounded' },
    created: '2026-11-12T08:00:00.000Z',
    scans: 500,
  };
}

describe('the studio', () => {
  it('saves a code and lists it, without taking the counts from the client', async () => {
    const admin = await api(ADMIN_A);
    const saved = await admin.put('/qr/codes/nile-menu').send({ rec: menu('Nile menu') });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toEqual({ id: 'nile-menu' });

    const list = await admin.get('/qr/codes');
    expect(list.status).toBe(200);
    const codes = list.body.data.codes as Record<string, unknown>[];
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({
      id: 'nile-menu',
      name: 'Nile menu',
      type: 'menu',
      data: { items: 'Tea | 20' },
      design: { dots: 'rounded' },
      created: '2026-11-12T08:00:00.000Z',
      scans: 0,
      scanLog: [],
      feedback: [],
    });
  });

  it('replaces a code saved again under the same link', async () => {
    const admin = await api(ADMIN_A);
    expect((await admin.put('/qr/codes/nile-menu').send({ rec: menu('Nile menu 2') })).status).toBe(
      200,
    );
    const codes = (await admin.get('/qr/codes')).body.data.codes as Record<string, unknown>[];
    expect(codes.map((c) => c.name)).toEqual(['Nile menu 2']);
  });

  it('accepts a record with embedded pictures larger than ordinary requests', async () => {
    const admin = await api(ADMIN_A);
    const picture = `data:image/jpeg;base64,${'A'.repeat(600 * 1024)}`;
    const response = await admin
      .put('/qr/codes/big-page')
      .send({ rec: { ...menu('Big'), page: { cover: picture } } });
    expect(response.status).toBe(200);
  });

  it('keeps every other endpoint at the ordinary body limit', async () => {
    const response = await visitor()
      .post(`/${API_PREFIX}/public/qr/nile-menu/event`)
      .send({ name: 'x', padding: 'A'.repeat(200 * 1024) });
    // Refused by the body parser before any handler runs. (The error filter
    // reports a parser's PayloadTooLargeError as a 500 for every route alike.)
    expect(response.status).toBeGreaterThanOrEqual(400);
    const codes = (await (await api(ADMIN_A)).get('/qr/codes')).body.data.codes as {
      id: string;
      scanLog: unknown[];
    }[];
    expect(codes.find((c) => c.id === 'nile-menu')?.scanLog).toEqual([]);
  });

  it('refuses a malformed link or record', async () => {
    const admin = await api(ADMIN_A);
    expect((await admin.put('/qr/codes/a b').send({ rec: menu('x') })).status).toBe(422);
    expect((await admin.put('/qr/codes/ok-link').send({ rec: { type: 'nope' } })).status).toBe(422);
    expect((await admin.put('/qr/codes/ok-link').send({})).status).toBe(422);
  });

  it('keeps each company to its own codes, with links unique across companies', async () => {
    const adminB = await api(ADMIN_B);
    expect((await adminB.get('/qr/codes')).body.data.codes).toEqual([]);
    expect((await adminB.get('/qr/slugs/nile-menu')).body.data).toEqual({ free: false });
    expect((await adminB.put('/qr/codes/nile-menu').send({ rec: menu('Theirs') })).status).toBe(
      409,
    );
    expect((await adminB.delete('/qr/codes/nile-menu')).status).toBe(204);
    const admin = await api(ADMIN_A);
    expect((await admin.get('/qr/slugs/nile-menu')).body.data).toEqual({ free: true });
    expect((await admin.get('/qr/slugs/brand-new')).body.data).toEqual({ free: true });
    expect((await admin.get('/qr/codes')).body.data.codes).toHaveLength(2);
  });

  it('is for the company admins only', async () => {
    const employee = await api(EMPLOYEE_A);
    expect((await employee.get('/qr/codes')).status).toBe(403);
    expect((await employee.put('/qr/codes/mine').send({ rec: menu('x') })).status).toBe(403);
    expect((await visitor().get(`/${API_PREFIX}/qr/codes`)).status).toBe(401);
  });
});

describe('the public scan page', () => {
  it('counts a scan with the visitor details and returns the page', async () => {
    const response = await visitor()
      .post(`/${API_PREFIX}/public/qr/nile-menu/scan`)
      .set('User-Agent', ANDROID)
      .set('Accept-Language', 'ar-EG,ar;q=0.9')
      .set('cf-ipcountry', 'EG')
      .send({ unique: true });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      slug: 'nile-menu',
      type: 'menu',
      data: { items: 'Tea | 20' },
      page: { title: 'Nile menu 2' },
      redirect: null,
    });

    const codes = (await (await api(ADMIN_A)).get('/qr/codes')).body.data.codes as {
      id: string;
      scans: number;
      scanLog: Record<string, unknown>[];
    }[];
    const code = codes.find((c) => c.id === 'nile-menu');
    expect(code?.scans).toBe(1);
    expect(code?.scanLog).toEqual([
      expect.objectContaining({
        k: 's',
        u: true,
        os: 'Android',
        browser: 'Chrome',
        lang: 'ar',
        country: 'EG',
      }),
    ]);
  });

  it('sends a website code straight to its address', async () => {
    const admin = await api(ADMIN_A);
    await admin.put('/qr/codes/shop').send({
      rec: { name: 'Shop', type: 'website', data: { url: 'https://wilo-eg.com' } },
    });
    const response = await visitor().post(`/${API_PREFIX}/public/qr/shop/scan`).send({});
    expect(response.body.data.redirect).toBe('https://wilo-eg.com/');
  });

  it('records clicks, and ratings on feedback codes only', async () => {
    const admin = await api(ADMIN_A);
    await admin.put('/qr/codes/rate-us').send({ rec: { name: 'Rate us', type: 'feedback' } });
    expect(
      (await visitor().post(`/${API_PREFIX}/public/qr/nile-menu/event`).send({ name: 'Call' }))
        .status,
    ).toBe(204);
    expect(
      (await visitor().post(`/${API_PREFIX}/public/qr/nile-menu/feedback`).send({ stars: 5 }))
        .status,
    ).toBe(404);
    expect(
      (
        await visitor()
          .post(`/${API_PREFIX}/public/qr/rate-us/feedback`)
          .send({ stars: 4, text: 'Good tea' })
      ).status,
    ).toBe(204);
    expect(
      (await visitor().post(`/${API_PREFIX}/public/qr/rate-us/feedback`).send({ stars: 9 })).status,
    ).toBe(422);

    const codes = (await admin.get('/qr/codes')).body.data.codes as {
      id: string;
      scanLog: { k: string; event: string | null }[];
      feedback: { stars: number; text: string }[];
    }[];
    expect(codes.find((c) => c.id === 'nile-menu')?.scanLog.map((e) => [e.k, e.event])).toEqual([
      ['s', null],
      ['e', 'Call'],
    ]);
    expect(codes.find((c) => c.id === 'rate-us')?.feedback).toEqual([
      expect.objectContaining({ stars: 4, text: 'Good tea' }),
    ]);
  });

  it('clears statistics on reset', async () => {
    const admin = await api(ADMIN_A);
    expect((await admin.post('/qr/codes/nile-menu/reset')).status).toBe(204);
    const code = ((await admin.get('/qr/codes')).body.data.codes as Record<string, unknown>[]).find(
      (c) => c.id === 'nile-menu',
    );
    expect(code).toMatchObject({ scans: 0, scanLog: [] });
  });

  it('answers 404 for an unknown or deleted link', async () => {
    expect((await visitor().post(`/${API_PREFIX}/public/qr/nobody/scan`).send({})).status).toBe(
      404,
    );
    const admin = await api(ADMIN_A);
    expect((await admin.delete('/qr/codes/shop')).status).toBe(204);
    expect((await visitor().post(`/${API_PREFIX}/public/qr/shop/scan`).send({})).status).toBe(404);
  });
});

describe('files', () => {
  it('uploads a PDF and serves it to anyone with the link', async () => {
    const admin = await api(ADMIN_A);
    const pdf = Buffer.from('%PDF-1.4\n%menu\n');
    const uploaded = await admin
      .post('/qr/files')
      .attach('file', pdf, { filename: 'menu.pdf', contentType: 'application/pdf' });
    expect(uploaded.status).toBe(201);
    const id = uploaded.body.data.id as string;

    const served = await visitor().get(`/${API_PREFIX}/public/qr/files/${id}`);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('application/pdf');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(served.body as Buffer).equals(pdf)).toBe(true);
  });

  it('refuses a file type a code cannot carry', async () => {
    const admin = await api(ADMIN_A);
    const response = await admin
      .post('/qr/files')
      .attach('file', Buffer.from('<script>'), { filename: 'x.html', contentType: 'text/html' });
    expect(response.status).toBe(422);
    expect((await visitor().get(`/${API_PREFIX}/public/qr/files/${generateId()}`)).status).toBe(
      404,
    );
  });
});
