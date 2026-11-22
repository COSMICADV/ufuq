/**
 * Business — Medical, phase M0 end-to-end: patients, visits, the medical team
 * and per-employee medical permissions.
 *
 * What is proved over HTTP, with row-level security enforced (the connection
 * runs as `ufuq_app`):
 *   - a company that is not medical has no medical routes (404);
 *   - an employee has no clinical access until the admin grants it;
 *   - an "assigned" doctor's lists, search and lookups hold only their own
 *     patients (primary doctor or care team) — anyone else's file is a 404;
 *   - reception books visits but never reads or writes clinical notes;
 *   - finance sees demographics only;
 *   - a non-admin cannot widen their own access or hand out staff.manage;
 *   - another company never sees these patients, and numbers its own files;
 *   - every change is audited without clinical content in the audit row.
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
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { ErrorFilter } from '../src/common/error.filter.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { createValidationPipe } from '../src/common/validation-pipe.js';
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

type Preset = Record<string, readonly (readonly [string, string])[]>;
let presets: Preset = {};

async function grantRole(employeeId: string, role: string, extra: readonly (readonly [string, string])[] = []) {
  const grants = [...(presets[role] ?? []), ...extra].map(([key, scope]) => ({ key, scope }));
  return (await api(ADMIN)).put(`/medical/staff/${employeeId}`).send({ clinical_role: role, permissions: grants });
}

let p1 = '';
let p2 = '';
let visit = '';

describe('medical — access', () => {
  it('a company that is not medical has no medical routes', async () => {
    const shop = await api(ADMIN_SHOP);
    const me = await shop.get('/medical/me');
    expect(me.status).toBe(200);
    expect(me.body.data.enabled).toBe(false);
    expect((await shop.get('/medical/patients')).status).toBe(404);
  });

  it('the admin holds every permission; an employee holds none until granted', async () => {
    const me = await (await api(ADMIN)).get('/medical/me');
    expect(me.body.data).toMatchObject({ enabled: true, admin: true });
    expect(me.body.data.permissions['documents.view']).toBe('all');
    const doc = await api(DOCTOR_1);
    const mine = await doc.get('/medical/me');
    expect(mine.body.data).toMatchObject({ enabled: true, admin: false, permissions: {} });
    expect((await doc.get('/medical/patients')).status).toBe(403);
    expect((await doc.get('/medical/staff')).status).toBe(403);
  });

  it('the admin sets up the team from the role presets', async () => {
    const staff = await (await api(ADMIN)).get('/medical/staff');
    expect(staff.status).toBe(200);
    presets = staff.body.data.presets as Preset;
    expect(staff.body.data.staff).toHaveLength(4);
    for (const [id, role] of [
      [doctor1, 'doctor'],
      [doctor2, 'doctor'],
      [reception, 'reception'],
      [finance, 'finance'],
    ] as const) {
      const saved = await grantRole(id, role);
      expect(saved.status).toBe(200);
      expect(saved.body.data.clinical_role).toBe(role);
    }
    const me = await (await api(DOCTOR_1)).get('/medical/me');
    expect(me.body.data.permissions).toMatchObject({ 'patients.view': 'assigned', 'visits.clinical': 'assigned' });
  });
});

describe('medical — patients', () => {
  it('reception registers patients with sequential file numbers', async () => {
    const desk = await api(RECEPTION);
    const a = await desk.post('/medical/patients').send({
      full_name: 'Hoda Kamal',
      date_of_birth: '1988-04-12',
      gender: 'female',
      phone: '+20 100 000 0001',
      primary_doctor_id: doctor1,
    });
    expect(a.status).toBe(201);
    expect(a.body.data.file_number).toBe('P-000001');
    expect(a.body.data.primary_doctor.name).toBe('Mona Clinic');
    expect(a.body.data.can).toMatchObject({ manage: true, clinical: false, documents: false });
    p1 = a.body.data.id as string;
    const b = await desk.post('/medical/patients').send({ full_name: 'Karim Youssef', primary_doctor_id: doctor2 });
    expect(b.body.data.file_number).toBe('P-000002');
    p2 = b.body.data.id as string;
    const bad = await desk.post('/medical/patients').send({ full_name: 'X Y', primary_doctor_id: finance });
    expect(bad.status).toBe(422);
  });

  it("a doctor's list, search and lookups hold only their own patients", async () => {
    const doc = await api(DOCTOR_1);
    const list = await doc.get('/medical/patients');
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([p1]);
    expect(list.body.meta.total).toBe(1);
    const search = await doc.get('/medical/patients?q=Karim');
    expect(search.body.data).toEqual([]);
    expect((await doc.get(`/medical/patients/${p2}`)).status).toBe(404);
    expect((await doc.get(`/medical/patients/${p2}/visits`)).status).toBe(404);
    const own = await doc.get(`/medical/patients/${p1}`);
    expect(own.status).toBe(200);
    expect(own.body.data.can).toMatchObject({ clinical: true, documents: true, assign: false });
  });

  it('an assigned doctor cannot change who reaches a file', async () => {
    const doc = await api(DOCTOR_1);
    const moved = await doc.patch(`/medical/patients/${p1}`).send({ primary_doctor_id: doctor2 });
    expect(moved.status).toBe(422);
    expect(moved.body.error.fields.primary_doctor_id).toEqual(['not_allowed']);
    const team = await doc.put(`/medical/patients/${p1}/team`).send({ employee_ids: [doctor2] });
    expect(team.status).toBe(422);
    const edit = await doc.patch(`/medical/patients/${p1}`).send({ phone: '+20 100 000 0009' });
    expect(edit.status).toBe(200);
  });

  it('joining the care team opens the file', async () => {
    const admin = await api(ADMIN);
    const team = await admin.put(`/medical/patients/${p2}/team`).send({ employee_ids: [doctor1] });
    expect(team.status).toBe(200);
    expect(team.body.data.care_team.map((m: { id: string }) => m.id)).toEqual([doctor1]);
    const list = await (await api(DOCTOR_1)).get('/medical/patients');
    expect(list.body.meta.total).toBe(2);
    const mine = await (await api(DOCTOR_1)).get('/medical/patients?mine=true');
    expect(mine.body.meta.total).toBe(2);
    await admin.put(`/medical/patients/${p2}/team`).send({ employee_ids: [] });
    expect((await (await api(DOCTOR_1)).get(`/medical/patients/${p2}`)).status).toBe(404);
  });

  it('finance sees demographics only', async () => {
    const money = await api(FINANCE);
    expect((await money.get('/medical/patients')).body.meta.total).toBe(2);
    const one = await money.get(`/medical/patients/${p1}`);
    expect(one.body.data.can).toMatchObject({ manage: false, view_visits: false, clinical: false, documents: false });
    expect((await money.get(`/medical/patients/${p1}/visits`)).status).toBe(403);
    expect((await money.post('/medical/patients').send({ full_name: 'Not Allowed' })).status).toBe(403);
  });
});

describe('medical — visits', () => {
  it('reception books a visit but cannot write clinical notes', async () => {
    const desk = await api(RECEPTION);
    const withNotes = await desk.post(`/medical/patients/${p1}/visits`).send({
      visit_at: '2026-11-25T08:00:00.000Z',
      doctor_id: doctor1,
      notes: 'Diagnosis…',
    });
    expect(withNotes.status).toBe(422);
    expect(withNotes.body.error.fields.notes).toEqual(['not_allowed']);
    const booked = await desk.post(`/medical/patients/${p1}/visits`).send({
      visit_at: '2026-11-25T08:00:00.000Z',
      doctor_id: doctor1,
      reason: 'Follow-up',
    });
    expect(booked.status).toBe(201);
    expect(booked.body.data).not.toHaveProperty('notes');
    visit = booked.body.data.id as string;
  });

  it('the doctor writes notes; reception never sees them', async () => {
    const doc = await api(DOCTOR_1);
    const noted = await doc.patch(`/medical/visits/${visit}`).send({ notes: 'BP 120/80, stable', status: 'completed' });
    expect(noted.status).toBe(200);
    expect(noted.body.data.notes).toBe('BP 120/80, stable');
    const desk = await (await api(RECEPTION)).get(`/medical/patients/${p1}/visits`);
    expect(desk.body.data).toHaveLength(1);
    expect(desk.body.data[0]).not.toHaveProperty('notes');
    expect(desk.body.data[0].status).toBe('completed');
    const day = await (await api(RECEPTION)).get('/medical/visits?from=2026-11-25T00:00:00.000Z&to=2026-11-26T00:00:00.000Z');
    expect(day.body.data).toHaveLength(1);
    expect(day.body.data[0]).not.toHaveProperty('notes');
    const other = await (await api(DOCTOR_2)).get('/medical/visits?from=2026-11-25T00:00:00.000Z&to=2026-11-26T00:00:00.000Z');
    expect(other.body.data).toEqual([]);
    expect((await (await api(DOCTOR_2)).patch(`/medical/visits/${visit}`).send({ notes: 'x' })).status).toBe(404);
  });

  it('an archived file takes no new visits and leaves the list', async () => {
    const desk = await api(RECEPTION);
    expect((await desk.post(`/medical/patients/${p2}/archive`)).status).toBe(201);
    expect((await desk.get('/medical/patients')).body.meta.total).toBe(1);
    expect((await desk.get('/medical/patients?archived=true')).body.meta.total).toBe(1);
    const refused = await desk.post(`/medical/patients/${p2}/visits`).send({ visit_at: '2026-11-26T08:00:00.000Z' });
    expect(refused.status).toBe(422);
    expect((await desk.post(`/medical/patients/${p2}/restore`)).status).toBe(201);
  });
});

describe('medical — team permissions', () => {
  it("an admin's access is not edited; a non-admin cannot widen their own or hand out staff.manage", async () => {
    const staff = await (await api(ADMIN)).get('/medical/staff');
    expect(staff.body.data.staff.every((s: { is_admin: boolean }) => !s.is_admin)).toBe(true);
    const granted = await grantRole(reception, 'reception', [['staff.manage', 'all']]);
    expect(granted.status).toBe(200);
    const desk = await api(RECEPTION);
    const self = await desk.put(`/medical/staff/${reception}`).send({
      clinical_role: 'reception',
      permissions: [{ key: 'documents.view', scope: 'all' }, { key: 'staff.manage', scope: 'all' }],
    });
    expect(self.status).toBe(422);
    const handOut = await desk.put(`/medical/staff/${finance}`).send({
      clinical_role: 'finance',
      permissions: [{ key: 'staff.manage', scope: 'all' }],
    });
    expect(handOut.status).toBe(422);
    const fine = await desk.put(`/medical/staff/${finance}`).send({
      clinical_role: 'finance',
      permissions: [{ key: 'patients.view', scope: 'all' }],
    });
    expect(fine.status).toBe(200);
    await grantRole(reception, 'reception');
  });

  it('removing someone from the team removes every grant', async () => {
    const removed = await (await api(ADMIN)).put(`/medical/staff/${finance}`).send({ clinical_role: null, permissions: [] });
    expect(removed.status).toBe(200);
    expect((await (await api(FINANCE)).get('/medical/patients')).status).toBe(403);
  });
});

describe('medical — isolation and audit', () => {
  it('another clinic never sees these patients and numbers its own files', async () => {
    const other = await api(ADMIN_OTHER);
    expect((await other.get('/medical/patients')).body.meta.total).toBe(0);
    expect((await other.get(`/medical/patients/${p1}`)).status).toBe(404);
    expect((await other.patch(`/medical/visits/${visit}`).send({ reason: 'x' })).status).toBe(404);
    expect((await other.put(`/medical/staff/${doctor1}`).send({ clinical_role: 'doctor', permissions: [] })).status).toBe(404);
    const own = await other.post('/medical/patients').send({ full_name: 'Other Patient' });
    expect(own.body.data.file_number).toBe('P-000001');
  });

  it('changes are audited without clinical content', async () => {
    const rows = await withTenant(prisma, CLINIC, (tx) =>
      tx.auditLog.findMany({
        where: { action: { in: ['PATIENT_CREATED', 'PATIENT_UPDATED', 'MEDICAL_VISIT_UPDATED', 'MEDICAL_PERMISSIONS_CHANGED'] } },
      }),
    );
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(new Set(['PATIENT_CREATED', 'PATIENT_UPDATED', 'MEDICAL_VISIT_UPDATED', 'MEDICAL_PERMISSIONS_CHANGED']));
    const text = JSON.stringify(rows.map((r) => [r.oldValues, r.newValues]));
    expect(text).not.toContain('Hoda');
    expect(text).not.toContain('BP 120/80');
    expect(text).not.toContain('+20 100');
  });
});
