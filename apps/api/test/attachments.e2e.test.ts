/**
 * The attachment store, end to end — Phase 7 addendum (approved 2026-10-05).
 * DOCUMENT 08 §4.14, DOCUMENT 06 §3.36, DOCUMENT 20 §§3 and 7, DOCUMENT 21,
 * DOCUMENT 26 §§5 and 12, AD-02.
 *
 * Real Nest, real guards, real multipart parsing, real DTO validation, real
 * PostgreSQL with row-level security enforced as `ufuq_app`. Redis and the
 * object store are in-memory stand-ins, so what reached storage can be read
 * back and asserted.
 *
 * Actors: an ADMIN (company scope), a MANAGER (team scope) with one report
 * (WORKER), an employee outside that team (OUTSIDER), and a second company.
 */

import { createHash } from 'node:crypto';

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

import { DISGUISES, PDF_MIME, SAMPLES } from './attachment-samples.js';
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

const COMPANY_A = generateId();
const COMPANY_B = generateId();
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ADMIN_A = { email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { email: 'admin@b.test', password: 'admin-b-password-2026' };
const MANAGER = { email: 'manager@a.test', password: 'manager-password-2026' };
const WORKER = { email: 'worker@a.test', password: 'worker-password-2026' };
const OUTSIDER = { email: 'outsider@a.test', password: 'outsider-password-2026' };

/** Assigned to WORKER, in MANAGER's team. */
let workerTaskId = '';
/** Assigned to OUTSIDER, outside MANAGER's team. */
let outsiderTaskId = '';
/** In company B. */
let taskBId = '';

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
      maxUploadBytes: MAX_UPLOAD_BYTES,
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
  const managerId = await createEmployee(ADMIN_A, {
    first_name: 'Mona',
    last_name: 'Saleh',
    email: MANAGER.email,
    employee_code: 'MGR-1',
    role_key: 'manager',
    work_schedule_id: scheduleId,
  });
  const workerId = await createEmployee(ADMIN_A, {
    first_name: 'Omar',
    last_name: 'Fathy',
    email: WORKER.email,
    employee_code: 'EMP-1',
    role_key: 'employee',
    manager_id: managerId,
    work_schedule_id: scheduleId,
  });
  const outsiderId = await createEmployee(ADMIN_A, {
    first_name: 'Layla',
    last_name: 'Nabil',
    email: OUTSIDER.email,
    employee_code: 'EMP-2',
    role_key: 'employee',
    work_schedule_id: scheduleId,
  });
  await activate(MANAGER);
  await activate(WORKER);
  await activate(OUTSIDER);
  workerTaskId = await createTask(ADMIN_A, workerId);
  outsiderTaskId = await createTask(ADMIN_A, outsiderId);

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
    email: 'worker@b.test',
    employee_code: 'B-1',
    role_key: 'employee',
    work_schedule_id: scheduleB.body.data.id as string,
  });
  taskBId = await createTask(ADMIN_B, workerBId);
}, 120_000);

afterAll(async () => {
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

async function tokenFor(account: Account): Promise<string> {
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
  return token;
}

async function api(account: Account) {
  const bearer = `Bearer ${await tokenFor(account)}`;
  const agent = request(server());
  return {
    get: (path: string) => agent.get(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    post: (path: string) => agent.post(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    delete: (path: string) => agent.delete(`/${API_PREFIX}${path}`).set('Authorization', bearer),
  };
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
  const token = message === undefined ? undefined : /#token=([^\s"']+)/.exec(message.text)?.[1];
  if (token === undefined) throw new Error(`No invitation for ${account.email}`);
  const accepted = await request(server())
    .post(`/${API_PREFIX}/auth/accept-invitation`)
    .send({ token: decodeURIComponent(token), password: account.password, accept_terms: true });
  if (accepted.status !== 200) throw new Error(`Activation failed for ${account.email}`);
}

async function createTask(account: Account, assigneeId: string): Promise<string> {
  const response = await (await api(account)).post('/tasks').send({
    title: 'Prepare the quarterly report',
    priority: 'medium',
    assignee_employee_id: assigneeId,
  });
  if (response.status !== 201)
    throw new Error(`Task create failed: ${JSON.stringify(response.body)}`);
  return response.body.data.id as string;
}

interface UploadOptions {
  readonly taskId?: string;
  readonly bytes?: Buffer;
  readonly mime?: string;
  readonly name?: string;
  readonly fields?: Readonly<Record<string, string>>;
  readonly withFile?: boolean;
}

/** `POST /attachments`, multipart — a PDF on WORKER's task unless told otherwise. */
async function upload(account: Account, options: UploadOptions = {}) {
  redis.reset(); // the upload rate limit has its own test; keep it out of the others
  let builder = (await api(account))
    .post('/attachments')
    .field('related_type', 'task')
    .field('related_id', options.taskId ?? workerTaskId);
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    builder = builder.field(key, value);
  }
  if (options.withFile !== false) {
    builder = builder.attach('file', options.bytes ?? SAMPLES.pdf.bytes, {
      filename: options.name ?? SAMPLES.pdf.name,
      contentType: options.mime ?? PDF_MIME,
    });
  }
  return builder;
}

interface AttachmentBody {
  readonly id: string;
  readonly original_name: string;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly checksum: string;
  readonly related_type: string;
  readonly related_id: string;
  readonly uploaded_by: { id: string; name: string | null };
}

async function uploaded(account: Account, options: UploadOptions = {}): Promise<AttachmentBody> {
  const response = await upload(account, options);
  if (response.status !== 201) throw new Error(`Upload failed: ${JSON.stringify(response.body)}`);
  return response.body.data as AttachmentBody;
}

/** The raw row, read as the owning company — what the API never sends. */
async function rowOf(id: string) {
  return withTenant(prisma, COMPANY_A, (tx) => tx.attachment.findUniqueOrThrow({ where: { id } }));
}

async function download(account: Account, id: string) {
  return (await api(account))
    .get(`/attachments/${id}`)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        done(null, Buffer.concat(chunks));
      });
    });
}

// ---------------------------------------------------------------------------
// Upload — DOCUMENT 08 §4.14, DOCUMENT 20 §7
// ---------------------------------------------------------------------------

describe('POST /attachments — upload', () => {
  it('stores the file privately under a generated, company-namespaced key', async () => {
    const body = await uploaded(WORKER);
    expect(body).toMatchObject({
      original_name: 'report.pdf',
      mime_type: PDF_MIME,
      size_bytes: SAMPLES.pdf.bytes.length,
      related_type: 'task',
      related_id: workerTaskId,
      checksum: createHash('sha256').update(SAMPLES.pdf.bytes).digest('hex'),
    });
    expect(body.uploaded_by.name).toBe('Omar Fathy');

    const row = await rowOf(body.id);
    expect(row.storedPath).toMatch(new RegExp(`^${COMPANY_A}/[0-9a-f]{64}$`));
    expect(row.storedPath).not.toContain('report');
    const object = storage.objects.get(row.storedPath);
    expect(object?.body.equals(SAMPLES.pdf.bytes)).toBe(true);
    expect(object?.checksum).toBe(body.checksum);
  });

  it('never sends the storage key or any URL to the client', async () => {
    const response = await upload(WORKER);
    const text = JSON.stringify(response.body);
    expect(text).not.toMatch(/stored_path|storedPath|https?:\/\//);
    const row = await rowOf(response.body.data.id as string);
    expect(text).not.toContain(row.storedPath);
  });

  it.each(Object.entries(SAMPLES))(
    'accepts %s — DOCUMENT 20 §7 allowlist',
    async (_kind, sample) => {
      const response = await upload(ADMIN_A, {
        bytes: sample.bytes,
        mime: sample.mime,
        name: sample.name,
      });
      expect(response.status).toBe(201);
      expect(response.body.data.mime_type).toBe(sample.mime);
    },
  );

  it.each(DISGUISES)(
    'refuses %s — MIME and magic bytes must agree',
    async (_label, mime, bytes) => {
      const before = storage.objects.size;
      const response = await upload(ADMIN_A, { bytes, mime, name: 'innocent.pdf' });
      expect(response.status).toBe(422);
      expect(response.body.error.fields).toEqual({ file: ['unsupported_type'] });
      expect(storage.objects.size).toBe(before);
    },
  );

  it('accepts a file of exactly the configured size, and refuses one byte more', async () => {
    const exact = Buffer.alloc(MAX_UPLOAD_BYTES, 0x20);
    SAMPLES.pdf.bytes.copy(exact);
    expect((await upload(ADMIN_A, { bytes: exact })).status).toBe(201);

    const over = Buffer.alloc(MAX_UPLOAD_BYTES + 1, 0x20);
    SAMPLES.pdf.bytes.copy(over);
    const response = await upload(ADMIN_A, { bytes: over });
    expect(response.status).toBe(422);
    expect(response.body.error.fields).toEqual({ file: ['too_large'] });
  }, 30_000);

  it('requires a non-empty file', async () => {
    const missing = await upload(ADMIN_A, { withFile: false });
    expect(missing.status).toBe(422);
    expect(missing.body.error.fields).toEqual({ file: ['required'] });
    const empty = await upload(ADMIN_A, { bytes: Buffer.alloc(0) });
    expect(empty.status).toBe(422);
  });

  it('keeps the original name as sanitised metadata only — DOCUMENT 20 §4', async () => {
    // A raw control byte in a multipart header makes the request itself
    // malformed (400); control characters are covered by the sanitiser's unit
    // tests. Here: a traversal path and reserved characters.
    const traversal = await uploaded(ADMIN_A, { name: '../../etc/passwd.pdf' });
    expect(traversal.original_name).toBe('passwd.pdf');
    const reserved = await uploaded(ADMIN_A, { name: 'a<b>|c?.pdf' });
    expect(reserved.original_name).toBe('a_b__c_.pdf');
    const arabic = await uploaded(ADMIN_A, { name: 'تقرير الربع الأول.pdf' });
    expect(arabic.original_name).toBe('تقرير الربع الأول.pdf');
    expect((await rowOf(arabic.id)).storedPath).not.toContain('تقرير');
  });

  it('refuses company_id, an unregistered related type and a malformed id', async () => {
    for (const [fields, field] of [[{ company_id: COMPANY_B }, 'company_id']] as const) {
      const response = await upload(ADMIN_A, { fields });
      expect(response.status).toBe(422);
      expect(response.body.error.fields).toHaveProperty(field);
    }
    redis.reset();
    const unknownType = await (await api(ADMIN_A))
      .post('/attachments')
      .field('related_type', 'employee')
      .field('related_id', workerTaskId)
      .attach('file', SAMPLES.pdf.bytes, { filename: 'a.pdf', contentType: PDF_MIME });
    expect(unknownType.status).toBe(422);
    expect(unknownType.body.error.fields).toHaveProperty('related_type');
    const badId = await upload(ADMIN_A, { taskId: 'not-a-uuid' });
    expect(badId.status).toBe(422);
    expect(badId.body.error.fields).toHaveProperty('related_id');
  });

  it('requires a session', async () => {
    const response = await request(server())
      .post(`/${API_PREFIX}/attachments`)
      .field('related_type', 'task')
      .field('related_id', workerTaskId)
      .attach('file', SAMPLES.pdf.bytes, { filename: 'a.pdf', contentType: PDF_MIME });
    expect(response.status).toBe(401);
  });
});

describe('upload rate limit — DOCUMENT 08 §6: 30 per hour per user', () => {
  it('refuses the 31st upload in the window with 429 and Retry-After, for that user only', async () => {
    const outsider = await api(OUTSIDER);
    redis.reset();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await outsider
        .post('/attachments')
        .field('related_type', 'task')
        .field('related_id', outsiderTaskId)
        .attach('file', SAMPLES.png.bytes, { filename: 'p.png', contentType: 'image/png' });
      expect(response.status).toBe(201);
    }
    const refused = await outsider
      .post('/attachments')
      .field('related_type', 'task')
      .field('related_id', outsiderTaskId)
      .attach('file', SAMPLES.png.bytes, { filename: 'p.png', contentType: 'image/png' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    // Another user is unaffected.
    const worker = await (await api(WORKER))
      .post('/attachments')
      .field('related_type', 'task')
      .field('related_id', workerTaskId)
      .attach('file', SAMPLES.png.bytes, { filename: 'p.png', contentType: 'image/png' });
    expect(worker.status).toBe(201);
    redis.reset();
  });
});

// ---------------------------------------------------------------------------
// Task scope — who may add a file
// ---------------------------------------------------------------------------

describe('who may upload to a task', () => {
  it('the assignee, on their own task', async () => {
    expect((await upload(WORKER)).status).toBe(201);
  });

  it('a manager, within their team; an admin, anywhere in the company', async () => {
    expect((await upload(MANAGER)).status).toBe(201);
    expect((await upload(ADMIN_A, { taskId: outsiderTaskId })).status).toBe(201);
  });

  it('nobody outside the task’s scope — 404, its existence not confirmed', async () => {
    expect((await upload(OUTSIDER, { taskId: workerTaskId })).status).toBe(404);
    expect((await upload(MANAGER, { taskId: outsiderTaskId })).status).toBe(404);
    expect((await upload(WORKER, { taskId: generateId() })).status).toBe(404);
  });

  it('nobody from another company — related_id cannot reach across tenants', async () => {
    const before = storage.objects.size;
    expect((await upload(ADMIN_B, { taskId: workerTaskId })).status).toBe(404);
    expect((await upload(ADMIN_A, { taskId: taskBId })).status).toBe(404);
    expect(storage.objects.size).toBe(before);
  });

  it('nobody, once the task is deleted', async () => {
    const outsiderEmployee = (await (await api(ADMIN_A)).get(`/tasks/${outsiderTaskId}`)).body.data
      .assignee.id as string;
    const doomed = await createTask(ADMIN_A, outsiderEmployee);
    expect((await (await api(ADMIN_A)).delete(`/tasks/${doomed}`)).status).toBe(204);
    expect((await upload(ADMIN_A, { taskId: doomed })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Download — authorization-checked stream
// ---------------------------------------------------------------------------

describe('GET /attachments/{id} — download', () => {
  it('streams the exact bytes, as a download that cannot run in the app’s origin', async () => {
    const file = await uploaded(WORKER, { name: 'تقرير.pdf' });
    const response = await download(WORKER, file.id);
    expect(response.status).toBe(200);
    expect((response.body as Buffer).equals(SAMPLES.pdf.bytes)).toBe(true);
    expect(response.headers['content-type']).toBe(PDF_MIME);
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="_____.pdf"; filename*=UTF-8''${encodeURIComponent('تقرير.pdf')}`,
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain('sandbox');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['repr-digest']).toBe(
      `sha-256=:${Buffer.from(file.checksum, 'hex').toString('base64')}:`,
    );
  });

  it('follows the task’s view scope: assignee, manager and admin see it', async () => {
    const file = await uploaded(WORKER);
    for (const account of [WORKER, MANAGER, ADMIN_A]) {
      expect((await download(account, file.id)).status).toBe(200);
    }
  });

  it('is 404 outside the task’s scope, across companies, and for an unknown id', async () => {
    const file = await uploaded(WORKER);
    expect((await download(OUTSIDER, file.id)).status).toBe(404);
    expect((await download(ADMIN_B, file.id)).status).toBe(404);
    expect((await download(WORKER, generateId())).status).toBe(404);
    expect((await (await api(WORKER)).get('/attachments/not-a-uuid')).status).toBe(400);
  });

  it('a manager cannot read an attachment on a task outside their team', async () => {
    const file = await uploaded(ADMIN_A, { taskId: outsiderTaskId });
    expect((await download(MANAGER, file.id)).status).toBe(404);
  });

  it('requires a session', async () => {
    const file = await uploaded(WORKER);
    expect((await request(server()).get(`/${API_PREFIX}/attachments/${file.id}`)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Delete — soft, audited, Admin/Manager only for tasks in V1
// ---------------------------------------------------------------------------

describe('DELETE /attachments/{id}', () => {
  it('is refused to the assignee, even for their own upload (V1)', async () => {
    const file = await uploaded(WORKER);
    const response = await (await api(WORKER)).delete(`/attachments/${file.id}`);
    expect(response.status).toBe(403);
    expect((await download(WORKER, file.id)).status).toBe(200);
  });

  it('is 404 outside the task’s scope and across companies', async () => {
    const file = await uploaded(WORKER);
    expect((await (await api(OUTSIDER)).delete(`/attachments/${file.id}`)).status).toBe(404);
    expect((await (await api(ADMIN_B)).delete(`/attachments/${file.id}`)).status).toBe(404);
    expect((await (await api(MANAGER)).delete(`/attachments/${generateId()}`)).status).toBe(404);
  });

  it('a manager removes a file on a team task: soft-deleted, kept in storage, then 404', async () => {
    const file = await uploaded(WORKER);
    const response = await (await api(MANAGER)).delete(`/attachments/${file.id}`);
    expect(response.status).toBe(204);

    const row = await rowOf(file.id);
    expect(row.deletedAt).not.toBeNull();
    expect(storage.objects.has(row.storedPath)).toBe(true);

    expect((await download(ADMIN_A, file.id)).status).toBe(404);
    expect((await (await api(MANAGER)).delete(`/attachments/${file.id}`)).status).toBe(404);
  });

  it('an admin removes a file anywhere in the company', async () => {
    const file = await uploaded(ADMIN_A, { taskId: outsiderTaskId });
    expect((await (await api(ADMIN_A)).delete(`/attachments/${file.id}`)).status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Audit — DOCUMENT 21
// ---------------------------------------------------------------------------

describe('audit — DOCUMENT 21', () => {
  async function auditsOf(id: string) {
    return withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({ where: { entityType: 'attachment', entityId: id } }),
    );
  }

  it('records attachment.uploaded and attachment.deleted with metadata, never contents', async () => {
    const file = await uploaded(WORKER, { name: 'evidence.pdf' });
    await download(WORKER, file.id);
    await (await api(MANAGER)).delete(`/attachments/${file.id}`);

    const logs = await auditsOf(file.id);
    expect(logs.map((log) => log.action).sort()).toEqual([
      'ATTACHMENT_DELETED',
      'ATTACHMENT_UPLOADED',
    ]);
    const row = await rowOf(file.id);
    for (const log of logs) {
      const text = JSON.stringify([log.oldValues, log.newValues]);
      expect(text).toContain('evidence.pdf');
      expect(text).toContain(file.checksum);
      expect(text).not.toContain(row.storedPath);
      expect(text).not.toContain(SAMPLES.pdf.bytes.toString('latin1'));
      expect(text).not.toContain(SAMPLES.pdf.bytes.toString('base64'));
    }
  });

  it('does not record attachment.accessed for a task file — tasks are not sensitive', async () => {
    const file = await uploaded(WORKER);
    await download(WORKER, file.id);
    await download(ADMIN_A, file.id);
    const logs = await auditsOf(file.id);
    expect(logs.map((log) => log.action)).toEqual(['ATTACHMENT_UPLOADED']);
  });

  it('is readable through the audit log as DOCUMENT 21 spells it', async () => {
    const file = await uploaded(WORKER);
    const response = await (await api(ADMIN_A)).get(`/audit-logs/entity/attachment/${file.id}`);
    expect(response.body.data.map((entry: { action: string }) => entry.action)).toEqual([
      'attachment.uploaded',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Task integration — the task detail carries its files
// ---------------------------------------------------------------------------

describe('task detail — attachments and what the caller may do with them', () => {
  interface TaskAttachments {
    readonly items: AttachmentBody[];
    readonly can_upload: boolean;
    readonly can_delete: boolean;
  }

  async function attachmentsOf(account: Account, taskId: string): Promise<TaskAttachments> {
    const response = await (await api(account)).get(`/tasks/${taskId}`);
    expect(response.status).toBe(200);
    return response.body.data.attachments as TaskAttachments;
  }

  it('lists the live files, newest first, and leaves deleted ones out', async () => {
    const first = await uploaded(WORKER, { name: 'first.pdf' });
    const second = await uploaded(WORKER, { name: 'second.pdf' });
    const gone = await uploaded(WORKER, { name: 'gone.pdf' });
    await (await api(MANAGER)).delete(`/attachments/${gone.id}`);

    const ids = (await attachmentsOf(WORKER, workerTaskId)).items.map((item) => item.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    expect(ids).not.toContain(gone.id);
    const text = JSON.stringify(await attachmentsOf(WORKER, workerTaskId));
    expect(text).not.toMatch(/stored_path|storedPath|https?:\/\//);
  });

  it('tells each role what the server will accept', async () => {
    expect(await attachmentsOf(WORKER, workerTaskId)).toMatchObject({
      can_upload: true,
      can_delete: false,
    });
    expect(await attachmentsOf(MANAGER, workerTaskId)).toMatchObject({
      can_upload: true,
      can_delete: true,
    });
    expect(await attachmentsOf(ADMIN_A, workerTaskId)).toMatchObject({
      can_upload: true,
      can_delete: true,
    });
  });

  it('a task in another company shows nothing — the task itself is 404', async () => {
    expect((await (await api(ADMIN_B)).get(`/tasks/${workerTaskId}`)).status).toBe(404);
  });
});
