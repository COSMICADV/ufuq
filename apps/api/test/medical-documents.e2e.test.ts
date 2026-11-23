/**
 * Business — Medical, phase M1 end-to-end: patient documents and their pages.
 *
 * Proved over HTTP with row-level security enforced: a document is filed only
 * into the patient whose file number the uploader confirms, and only with a
 * visit of that patient; the document's kind decides who may see it (a nurse
 * with documents and labs sees no imaging); reception, an unassigned doctor
 * and another clinic reach neither the documents nor their pages; archive and
 * delete need their own permissions; deleting keeps the record; downloads are
 * audited without file names.
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
import { SAMPLES } from './attachment-samples.js';
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

const CLINIC = generateId();
const OTHER_CLINIC = generateId();
const SHOP = generateId();

const ADMIN = { email: 'admin@clinic.test', password: 'clinic-admin-password-2026' };
const ADMIN_OTHER = { email: 'admin@other.test', password: 'other-admin-password-2026' };
const ADMIN_SHOP = { email: 'admin@shop.test', password: 'shop-admin-password-2026' };
const DOCTOR_1 = { email: 'mona@clinic.test', password: 'doctor-one-password-2026' };
const DOCTOR_2 = { email: 'omar@clinic.test', password: 'doctor-two-password-2026' };
const RECEPTION = { email: 'layla@clinic.test', password: 'reception-password-2026' };
const FINANCE = { email: 'sami@clinic.test', password: 'finance-password-2026' };

let doctor1 = '';
let doctor2 = '';
let reception = '';
let finance = '';

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
    [CLINIC, 'clinic', ADMIN, true],
    [OTHER_CLINIC, 'other-clinic', ADMIN_OTHER, true],
    [SHOP, 'shop', ADMIN_SHOP, false],
  ] as const) {
    const passwordHash = await hashPassword(admin.password);
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: {
          id: companyId,
          name: slug,
          slug,
          timezone: CAIRO,
          businessActivity: medical ? 'medical' : 'retail',
          businessSubtype: medical ? 'clinic' : null,
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
  doctor1 = await hire('Mona', DOCTOR_1, 'D-1');
  doctor2 = await hire('Omar', DOCTOR_2, 'D-2');
  reception = await hire('Layla', RECEPTION, 'R-1');
  finance = await hire('Sami', FINANCE, 'F-1');
  for (const account of [DOCTOR_1, DOCTOR_2, RECEPTION, FINANCE]) await activate(account);
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});


// ---------------------------------------------------------------------------
// `finance` / FINANCE is set up here as the clinic's nurse (Sami).

type Preset = Record<string, readonly (readonly [string, string])[]>;
let presets: Preset = {};
const NURSE = FINANCE;
let p1 = '';
let p2 = '';
let p1File = '';
let p2Visit = '';
let prescription = '';
let lab = '';
let xray = '';
let rxPage = '';
let xrayPage = '';

async function upload(account: Account, documentId: string): Promise<request.Response> {
  return (await api(account))
    .post('/attachments')
    .field('related_type', 'medical_document')
    .field('related_id', documentId)
    .attach('file', SAMPLES.png.bytes, { filename: 'page.png', contentType: 'image/png' });
}

describe('medical documents — setup', () => {
  it('the admin sets up the team and two patients', async () => {
    const admin = await api(ADMIN);
    presets = (await admin.get('/medical/staff')).body.data.presets as Preset;
    for (const [id, role] of [
      [doctor1, 'doctor'],
      [doctor2, 'doctor'],
      [reception, 'reception'],
      [finance, 'nurse'],
    ] as const) {
      const permissions = (presets[role] ?? []).map(([key, scope]) => ({ key, scope }));
      expect((await admin.put(`/medical/staff/${id}`).send({ clinical_role: role, permissions })).status).toBe(200);
    }
    const a = await admin.post('/medical/patients').send({ full_name: 'Hoda Kamal', primary_doctor_id: doctor1 });
    p1 = a.body.data.id as string;
    p1File = a.body.data.file_number as string;
    const b = await admin.post('/medical/patients').send({ full_name: 'Karim Youssef', primary_doctor_id: doctor2 });
    p2 = b.body.data.id as string;
    expect((await admin.put(`/medical/patients/${p1}/team`).send({ employee_ids: [finance] })).status).toBe(200);
    const v = await admin.post(`/medical/patients/${p2}/visits`).send({ visit_at: '2026-11-25T08:00:00.000Z', doctor_id: doctor2 });
    p2Visit = v.body.data.id as string;
    const cats = await admin.get('/medical/document-categories');
    expect(cats.body.data.filter((c: { custom: boolean }) => !c.custom)).toHaveLength(10);
  });
});

describe('medical documents — filing', () => {
  it('refuses a file number that is not this patient’s, and a visit of another patient', async () => {
    const doc = await api(DOCTOR_1);
    const wrong = await doc.post(`/medical/patients/${p1}/documents`).send({ patient_file_number: 'P-000002', category_key: 'prescription', title: 'Rx' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.fields.patient_file_number).toEqual(['mismatch']);
    const visit = await (await api(ADMIN)).post(`/medical/patients/${p1}/documents`).send({
      patient_file_number: p1File,
      category_key: 'prescription',
      title: 'Rx',
      visit_id: p2Visit,
    });
    expect(visit.status).toBe(422);
    expect(visit.body.error.fields.visit_id).toEqual(['not_found']);
  });

  it('the doctor files a prescription, a lab result and an X-ray with pages', async () => {
    const doc = await api(DOCTOR_1);
    const make = async (category_key: string, title: string): Promise<string> => {
      const res = await doc.post(`/medical/patients/${p1}/documents`).send({ patient_file_number: p1File, category_key, title, document_date: '2026-11-20' });
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };
    prescription = await make('prescription', 'Antibiotic course');
    lab = await make('lab_result', 'CBC');
    xray = await make('xray', 'Chest X-ray');
    const page = await upload(DOCTOR_1, prescription);
    expect(page.status).toBe(201);
    rxPage = page.body.data.id as string;
    xrayPage = (await upload(DOCTOR_1, xray)).body.data.id as string;
    const one = await doc.get(`/medical/documents/${prescription}`);
    expect(one.body.data.pages).toHaveLength(1);
    expect(one.body.data.can).toEqual({ upload: true, edit: true, archive: false, delete: false });
  });

  it('a doctor cannot move a document into a patient file they do not reach', async () => {
    const other = await api(DOCTOR_2);
    expect((await other.post(`/medical/patients/${p1}/documents`).send({ patient_file_number: p1File, category_key: 'prescription', title: 'x' })).status).toBe(404);
    expect((await upload(DOCTOR_2, prescription)).status).toBe(404);
  });
});

describe('medical documents — who sees what', () => {
  it('the nurse sees documents and labs but no imaging', async () => {
    const nurse = await api(NURSE);
    const list = await nurse.get(`/medical/patients/${p1}/documents`);
    expect(list.status).toBe(200);
    expect(list.body.data.kinds).toEqual(['document', 'lab']);
    expect(list.body.data.documents.map((d: { id: string }) => d.id).sort()).toEqual([prescription, lab].sort());
    expect((await nurse.get(`/medical/documents/${xray}`)).status).toBe(404);
    expect((await nurse.get(`/attachments/${xrayPage}`)).status).toBe(404);
    expect((await nurse.get(`/attachments/${rxPage}`)).status).toBe(200);
  });

  it('reception, an unassigned doctor and another clinic reach nothing', async () => {
    for (const account of [RECEPTION, DOCTOR_2, ADMIN_OTHER]) {
      const who = await api(account);
      const list = await who.get(`/medical/patients/${p1}/documents`);
      expect([403, 404], account.email).toContain(list.status);
      expect((await who.get(`/medical/documents/${prescription}`)).status, account.email).toBe(404);
      expect((await who.get(`/attachments/${rxPage}`)).status, account.email).toBe(404);
    }
    expect((await (await api(RECEPTION)).post(`/medical/patients/${p1}/documents`).send({ patient_file_number: p1File, category_key: 'prescription', title: 'x' })).status).toBe(403);
  });

  it('a document cannot be moved to a kind its editor cannot see', async () => {
    const nurse = await api(NURSE);
    // The nurse preset has no documents.edit at all.
    expect((await nurse.patch(`/medical/documents/${lab}`).send({ title: 'x' })).status).toBe(403);
    const admin = await api(ADMIN);
    const custom = await admin.post('/medical/document-categories').send({ name_ar: 'أشعة أسنان', name_en: 'Dental imaging', kind: 'imaging' });
    expect(custom.status).toBe(201);
    expect((await (await api(DOCTOR_1)).post('/medical/document-categories').send({ name_ar: 'x', name_en: 'x', kind: 'document' })).status).toBe(403);
    const moved = await (await api(DOCTOR_1)).patch(`/medical/documents/${lab}`).send({ custom_category_id: custom.body.data.id });
    expect(moved.status).toBe(200);
    expect(moved.body.data.category).toMatchObject({ custom: true, kind: 'imaging' });
    // Now imaging: the nurse no longer sees it.
    expect((await nurse.get(`/medical/documents/${lab}`)).status).toBe(404);
  });
});

describe('medical documents — archive and delete', () => {
  it('archive needs its permission; an archived document takes no pages', async () => {
    expect((await (await api(DOCTOR_1)).post(`/medical/documents/${prescription}/archive`)).status).toBe(403);
    const archived = await (await api(ADMIN)).post(`/medical/documents/${prescription}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toBe(true);
    expect((await upload(DOCTOR_1, prescription)).status).toBe(403);
    const list = await (await api(DOCTOR_1)).get(`/medical/patients/${p1}/documents?archived=true`);
    expect(list.body.data.documents.map((d: { id: string }) => d.id)).toEqual([prescription]);
    await (await api(ADMIN)).post(`/medical/documents/${prescription}/restore`);
  });

  it('delete needs its permission and keeps the record', async () => {
    expect((await (await api(DOCTOR_1)).delete(`/medical/documents/${xray}`)).status).toBe(403);
    expect((await (await api(ADMIN)).delete(`/medical/documents/${xray}`)).status).toBe(204);
    expect((await (await api(DOCTOR_1)).get(`/medical/documents/${xray}`)).status).toBe(404);
    expect((await (await api(DOCTOR_1)).get(`/attachments/${xrayPage}`)).status).toBe(404);
    const kept = await withTenant(prisma, CLINIC, (tx) => tx.medicalDocument.findUnique({ where: { id: xray } }));
    expect(kept?.deletedAt).not.toBeNull();
  });

  it('downloads and changes are audited without titles or file names', async () => {
    const rows = await withTenant(prisma, CLINIC, (tx) =>
      tx.auditLog.findMany({
        where: {
          action: {
            in: ['MEDICAL_DOCUMENT_CREATED', 'MEDICAL_DOCUMENT_UPDATED', 'MEDICAL_DOCUMENT_ARCHIVED', 'MEDICAL_DOCUMENT_DELETED', 'ATTACHMENT_ACCESSED'],
          },
        },
      }),
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ['MEDICAL_DOCUMENT_CREATED', 'MEDICAL_DOCUMENT_UPDATED', 'MEDICAL_DOCUMENT_ARCHIVED', 'MEDICAL_DOCUMENT_DELETED', 'ATTACHMENT_ACCESSED']) {
      expect(actions.has(a as never), a).toBe(true);
    }
    const text = JSON.stringify(rows.map((r) => [r.oldValues, r.newValues]));
    for (const secret of ['Antibiotic', 'CBC', 'Chest', 'page.png']) expect(text).not.toContain(secret);
  });
});
