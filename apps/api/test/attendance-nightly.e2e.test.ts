/**
 * The nightly attendance run, end to end, as the application role —
 * DOCUMENT 12 rule 10, AD-03, DOCUMENT 09 §7.
 *
 * `runNightly()` starts with no tenant at all: its first job is to find out
 * which companies exist. `companies` is under FORCE row-level security keyed on
 * `app.company_id`, so an ordinary query made before any tenant is bound sees
 * no companies — and a nightly run that enumerates nothing reports success
 * while generating nothing. The Phase 6 suite never caught this because it
 * drives `generateRange` for one company it already knows; this suite drives
 * the real entry point.
 *
 * What is proved, under `ufuq_app` with no BYPASSRLS:
 *
 *   - every active company is processed, and only active ones;
 *   - each company is processed inside its own tenant scope — its counts are
 *     its own employees, its rows carry its own id, its audit records name its
 *     own system actor;
 *   - no company can see another's generated rows afterwards;
 *   - the enumeration did not loosen row-level security: with no tenant bound,
 *     the role still sees no companies and no attendance.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { AttendanceGenerationService } from '../src/attendance/attendance-generation.service.js';
import type { GenerationResult } from '../src/attendance/attendance-generation.service.js';
import { PRISMA_CLIENT } from '../src/common/db.tokens.js';
import { REDIS_CLIENT } from '../src/common/redis.tokens.js';
import { MAIL_TRANSPORT } from '../src/mail/mail-transport.js';
import type { MailMessage, MailTransport } from '../src/mail/mail-transport.js';

import { FakeRedis } from './fake-redis.js';
import { allMigrationsSql } from './all-migrations.js';

let pglite: PGlite;
let socket: PGLiteSocketServer;
let app: INestApplication;
let prisma: PrismaClient;

class DiscardingMail implements MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
}

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };
const CAIRO = 'Africa/Cairo';

const COMPANY_A = generateId();
const COMPANY_B = generateId();
/** Suspended — the nightly run must leave it alone. */
const COMPANY_C = generateId();

const EMPLOYEE_A1 = generateId();
const EMPLOYEE_A2 = generateId();
const EMPLOYEE_B1 = generateId();

/** Two employees in A and one in B, so each company's count is its own. */
const EMPLOYEES: Record<string, string[]> = {
  [COMPANY_A]: [EMPLOYEE_A1, EMPLOYEE_A2],
  [COMPANY_B]: [EMPLOYEE_B1],
  [COMPANY_C]: [generateId()],
};

/**
 * 08:00 in Cairo on Wednesday 2026-03-04, so "yesterday" in every company's
 * zone is Tuesday 2026-03-03 — a working day in the fixture week, finished,
 * and with no record: exactly one `absent` row per employee.
 */
const NOW = new Date(Date.UTC(2026, 2, 4, 6, 0, 0));
const YESTERDAY = new Date(Date.UTC(2026, 2, 3));

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

/** Sunday(0) to Thursday(4) working, Friday and Saturday off. */
function week(scheduleId: string) {
  return Array.from({ length: 7 }, (_, day) => ({
    id: generateId(),
    workScheduleId: scheduleId,
    dayOfWeek: day,
    isWorkingDay: day <= 4,
    startTime: day <= 4 ? new Date('1970-01-01T09:00:00.000Z') : null,
    endTime: day <= 4 ? new Date('1970-01-01T17:00:00.000Z') : null,
  }));
}

async function seedCompany(
  companyId: string,
  slug: string,
  status: 'active' | 'suspended',
): Promise<void> {
  await withTenant(prisma, companyId, async (tx) => {
    await tx.company.create({ data: { id: companyId, name: slug, slug, timezone: CAIRO, status } });
    const scheduleId = generateId();
    await tx.workSchedule.create({
      data: {
        id: scheduleId,
        companyId,
        name: `${slug} week`,
        isDefault: true,
        timezone: CAIRO,
        gracePeriodMinutes: 15,
        halfDayThresholdHours: '4.00',
        overtimePolicy: 'paid',
        breakMinutes: 60,
      },
    });
    await tx.workScheduleDay.createMany({ data: week(scheduleId) });
    for (const [index, employeeId] of (EMPLOYEES[companyId] ?? []).entries()) {
      await tx.employee.create({
        data: {
          id: employeeId,
          companyId,
          employeeCode: `${slug}-${String(index + 1)}`,
          firstName: 'Test',
          lastName: `${slug} ${String(index + 1)}`,
          workScheduleId: scheduleId,
          joiningDate: new Date(Date.UTC(2026, 0, 5)),
        },
      });
    }
  });
}

let results: Map<string, GenerationResult>;

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
    .useValue(new FakeRedis())
    .overrideProvider(MAIL_TRANSPORT)
    .useValue(new DiscardingMail())
    .compile();

  app = moduleRef.createNestApplication();
  await app.init();
  prisma = app.get<PrismaClient>(PRISMA_CLIENT);

  // Reference data is written by the seed, which runs as the migration owner —
  // the one thing done here before the switch. `SystemActorService` needs the
  // `employee` system role to create each company's actor.
  const employeeRole = SYSTEM_ROLES.find((role) => role.key === 'employee');
  if (employeeRole === undefined) throw new Error('No employee system role in @ufuq/auth');
  await withPlatformContext(prisma, (tx) =>
    tx.role.create({
      data: {
        id: generateId(),
        companyId: null,
        key: employeeRole.key,
        nameEn: employeeRole.nameEn,
        nameAr: employeeRole.nameAr,
        isSystem: true,
      },
    }),
  );

  // From here on, everything — the fixtures and the run itself — is the
  // application role. `connection_limit=1` pins Prisma to this one connection
  // (see `packages/db/test/tenant-client.test.ts` for why `SET ROLE` rather
  // than a `ufuq_app@` connection string).
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  await seedCompany(COMPANY_A, 'company-a', 'active');
  await seedCompany(COMPANY_B, 'company-b', 'active');
  await seedCompany(COMPANY_C, 'company-c', 'suspended');

  results = await app.get(AttendanceGenerationService).runNightly(NOW);
}, 120_000);

afterAll(async () => {
  await app.close();
  await socket.stop();
  await pglite.close();
});

describe('runNightly() under the application role', () => {
  it('really is running as ufuq_app, which cannot bypass row-level security', async () => {
    const rows = await prisma.$queryRaw<
      { role: string; bypass: boolean; superuser: boolean }[]
    >`SELECT current_user AS role, rolbypassrls AS bypass, rolsuper AS superuser
      FROM pg_roles WHERE rolname = current_user`;
    expect(rows).toEqual([{ role: 'ufuq_app', bypass: false, superuser: false }]);
  });

  it('processes every active company, and only active ones', () => {
    expect([...results.keys()].sort()).toEqual([COMPANY_A, COMPANY_B].sort());
    expect(results.has(COMPANY_C)).toBe(false);
  });

  it('processes each company inside its own tenant scope — its own employees, no more', () => {
    // One absence per employee of that company. A count that included another
    // company's employees would mean the run saw across the tenant boundary.
    expect(results.get(COMPANY_A)).toEqual({ generated: 2, closed: 0, skipped: [] });
    expect(results.get(COMPANY_B)).toEqual({ generated: 1, closed: 0, skipped: [] });
  });

  it('writes each company’s rows under its own id, for its own employees only', async () => {
    for (const companyId of [COMPANY_A, COMPANY_B]) {
      const rows = await withTenant(prisma, companyId, (tx) =>
        tx.attendanceRecord.findMany({
          select: { companyId: true, employeeId: true, date: true, status: true, source: true },
        }),
      );
      expect(rows.map((row) => row.employeeId).sort()).toEqual(
        [...(EMPLOYEES[companyId] ?? [])].sort(),
      );
      for (const row of rows) {
        expect(row.companyId).toBe(companyId);
        expect(row.date).toEqual(YESTERDAY);
        expect(row.status).toBe('absent');
        expect(row.source).toBe('system');
      }
    }

    const suspended = await withTenant(prisma, COMPANY_C, (tx) => tx.attendanceRecord.count());
    expect(suspended).toBe(0);
  });

  it('attributes each company’s rows to that company’s own system actor', async () => {
    const actors: string[] = [];
    for (const companyId of [COMPANY_A, COMPANY_B]) {
      const { actor, logs } = await withTenant(prisma, companyId, async (tx) => ({
        actor: await tx.user.findFirstOrThrow({
          where: { isSystem: true },
          select: { id: true, companyId: true },
        }),
        logs: await tx.auditLog.findMany({
          where: { action: 'ATTENDANCE_GENERATED_BY_SYSTEM' },
          select: { companyId: true, userId: true },
        }),
      }));
      expect(actor.companyId).toBe(companyId);
      expect(logs).toHaveLength(EMPLOYEES[companyId]?.length ?? -1);
      for (const log of logs) {
        expect(log).toEqual({ companyId, userId: actor.id });
      }
      actors.push(actor.id);
    }
    expect(actors[0]).not.toBe(actors[1]);
  });

  it('leaves no company able to see another’s generated rows', async () => {
    const fromA = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.attendanceRecord.findMany({ where: { employeeId: EMPLOYEE_B1 } }),
    );
    const fromB = await withTenant(prisma, COMPANY_B, (tx) =>
      tx.attendanceRecord.findMany({ where: { employeeId: EMPLOYEE_A1 } }),
    );
    const auditsAcross = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.count({ where: { companyId: COMPANY_B } }),
    );

    expect(fromA).toEqual([]);
    expect(fromB).toEqual([]);
    expect(auditsAcross).toBe(0);
  });

  it('did not loosen row-level security: with no tenant bound, nothing is visible', async () => {
    const { companies, records } = await withPlatformContext(prisma, async (tx) => ({
      companies: await tx.company.findMany({ select: { id: true } }),
      records: await tx.attendanceRecord.count(),
    }));
    expect(companies).toEqual([]);
    expect(records).toBe(0);

    const inA = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.company.findMany({ select: { id: true } }),
    );
    expect(inA).toEqual([{ id: COMPANY_A }]);
  });
});
