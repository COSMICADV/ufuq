/**
 * The audit read surface, end to end — DOCUMENT 21 "API requirements" and
 * "Permissions", DOCUMENT 08 §4.16, DOCUMENT 26.
 *
 * Real Nest, real guards, real DTO validation, real PostgreSQL with row-level
 * security enforced under `ufuq_app`. The records read here are the ones the
 * application itself writes (logins, company settings changes), not rows
 * planted by the test, so what is proved is that the viewer shows what the
 * system actually recorded.
 */

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import { generateId, withPlatformContext, withTenant } from '@ufuq/db';
import type { AuditAction, PrismaClient, TenantClient } from '@ufuq/db';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PREFIX } from '../src/api-prefix.js';
import { AppModule } from '../src/app.module.js';
import type { AppInfo } from '../src/app.tokens.js';
import { AUDIT_RETRY_QUEUE, AuditDispatcher } from '../src/auth/audit-dispatcher.js';
import type { AuditRetryQueue, QueuedAuditEntry } from '../src/auth/audit-dispatcher.js';
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

/** Stands in for the BullMQ retry queue (no Redis here); `failing` simulates the queue being down too. */
class CapturingRetryQueue implements AuditRetryQueue {
  readonly entries: QueuedAuditEntry[] = [];
  failing = false;
  enqueue(entry: QueuedAuditEntry): Promise<void> {
    if (this.failing) return Promise.reject(new Error('retry queue unavailable'));
    this.entries.push(entry);
    return Promise.resolve();
  }
}
const retryQueue = new CapturingRetryQueue();

const redis = new FakeRedis();

class DiscardingMail implements MailTransport {
  send(_message: MailMessage): Promise<void> {
    return Promise.resolve();
  }
}

const APP_INFO: AppInfo = { name: 'ufuq-api-test', version: '0.0.0-test' };

const COMPANY_A = generateId();
const COMPANY_B = generateId();

const ADMIN_A = { id: generateId(), email: 'admin@a.test', password: 'admin-a-password-2026' };
const ADMIN_B = { id: generateId(), email: 'admin@b.test', password: 'admin-b-password-2026' };
/** Authenticated, but without `audit.view` — DOCUMENT 02: audit is ADMIN only. */
const MANAGER_A = { id: generateId(), email: 'manager@a.test', password: 'manager-a-pass-2026' };

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

  for (const [companyId, slug, users] of [
    [COMPANY_A, 'company-a', [[ADMIN_A, 'admin'] as const, [MANAGER_A, 'manager'] as const]],
    [COMPANY_B, 'company-b', [[ADMIN_B, 'admin'] as const]],
  ] as const) {
    await withTenant(prisma, companyId, async (tx) => {
      await tx.company.create({
        data: { id: companyId, name: slug, slug, timezone: 'Africa/Cairo' },
      });
      for (const [user, role] of users) {
        await tx.user.create({
          data: {
            id: user.id,
            companyId,
            email: user.email,
            passwordHash: await hashPassword(user.password),
            roleId: roleIdByKey.get(role) as string,
            status: 'active',
          },
        });
      }
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
    .useValue(new DiscardingMail())
    .overrideProvider(AUDIT_RETRY_QUEUE)
    .useValue(retryQueue)
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

  // Audit records the application writes itself: logins, and one settings
  // change per company with old and new values.
  await (await api(ADMIN_A)).patch('/company').send({ correction_window_days: 10 });
  await (await api(ADMIN_B)).patch('/company').send({ correction_window_days: 12 });
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
  const bearer = `Bearer ${token}`;
  return {
    get: (path: string) => agent.get(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    post: (path: string) => agent.post(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    put: (path: string) => agent.put(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    patch: (path: string) => agent.patch(`/${API_PREFIX}${path}`).set('Authorization', bearer),
    delete: (path: string) => agent.delete(`/${API_PREFIX}${path}`).set('Authorization', bearer),
  };
}

interface Entry {
  readonly id: string;
  readonly action: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly actor: { id: string; name: string | null; email: string; is_system: boolean };
  readonly old_values: Record<string, unknown> | null;
  readonly new_values: Record<string, unknown> | null;
  readonly created_at: string;
}

/** Today in Cairo, as the date filter reads it. */
function cairoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

// ---------------------------------------------------------------------------
// Permissions — DOCUMENT 21 "Permissions"
// ---------------------------------------------------------------------------

describe('audit.view only', () => {
  it('refuses an anonymous caller', async () => {
    const response = await request(server()).get(`/${API_PREFIX}/audit-logs`);
    expect(response.status).toBe(401);
  });

  it('refuses an authenticated caller without audit.view, on both endpoints', async () => {
    const manager = await api(MANAGER_A);
    expect((await manager.get('/audit-logs')).status).toBe(403);
    expect((await manager.get(`/audit-logs/entity/company/${COMPANY_A}`)).status).toBe(403);
  });

  it('serves an ADMIN', async () => {
    expect((await (await api(ADMIN_A)).get('/audit-logs')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tenancy — DOCUMENT 21 rule 7
// ---------------------------------------------------------------------------

describe('tenant scoped', () => {
  it('a company’s log contains only that company’s records', async () => {
    const response = await (await api(ADMIN_A)).get('/audit-logs?per_page=100');
    const entries = response.body.data as Entry[];
    expect(entries.length).toBeGreaterThan(0);
    const companyAUsers = new Set([ADMIN_A.id, MANAGER_A.id]);
    for (const entry of entries) {
      expect(companyAUsers.has(entry.actor.id)).toBe(true);
      expect(entry.entity_id).not.toBe(COMPANY_B);
      expect(entry.entity_id).not.toBe(ADMIN_B.id);
    }
  });

  it('another company’s record history is empty, not a confirmation that it exists', async () => {
    const response = await (await api(ADMIN_A)).get(`/audit-logs/entity/company/${COMPANY_B}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.total).toBe(0);
  });

  it('a filter naming another company’s user finds nothing', async () => {
    const response = await (await api(ADMIN_A)).get(`/audit-logs?user_id=${ADMIN_B.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Content — DOCUMENT 21 "Record content" and "UI"
// ---------------------------------------------------------------------------

describe('record content', () => {
  it('names actions as DOCUMENT 21 spells them, with old and new values', async () => {
    const response = await (await api(ADMIN_A)).get('/audit-logs?action=settings.company_updated');
    expect(response.status).toBe(200);
    const [entry] = response.body.data as Entry[];
    expect(entry?.action).toBe('settings.company_updated');
    expect(entry?.entity_type).toBe('company');
    expect(entry?.entity_id).toBe(COMPANY_A);
    expect(entry?.old_values).toMatchObject({ correction_window_days: 7 });
    expect(entry?.new_values).toMatchObject({ correction_window_days: 10 });
    expect(entry?.actor).toMatchObject({ id: ADMIN_A.id, email: ADMIN_A.email, is_system: false });
  });

  it('never carries a password, hash or token', async () => {
    const response = await (await api(ADMIN_A)).get('/audit-logs?per_page=100');
    const text = JSON.stringify(response.body.data);
    expect(text).not.toMatch(/password_hash|passwordHash|token_hash|accessToken/i);
    expect(text).not.toContain(ADMIN_A.password);
  });

  it('is newest first', async () => {
    const response = await (await api(ADMIN_A)).get('/audit-logs?per_page=100');
    const times = (response.body.data as Entry[]).map((entry) => entry.created_at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

// ---------------------------------------------------------------------------
// Filters and pagination — DOCUMENT 21 "API requirements", DOCUMENT 08 §1
// ---------------------------------------------------------------------------

describe('filters', () => {
  it('by user', async () => {
    const response = await (await api(ADMIN_A)).get(`/audit-logs?user_id=${ADMIN_A.id}`);
    for (const entry of response.body.data as Entry[]) {
      expect(entry.actor.id).toBe(ADMIN_A.id);
    }
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it('by entity type and entity id', async () => {
    const response = await (
      await api(ADMIN_A)
    ).get(`/audit-logs?entity_type=company&entity_id=${COMPANY_A}`);
    const entries = response.body.data as Entry[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.entity_type).toBe('company');
      expect(entry.entity_id).toBe(COMPANY_A);
    }
  });

  it('by action', async () => {
    const response = await (await api(ADMIN_A)).get('/audit-logs?action=login.success');
    const entries = response.body.data as Entry[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.action).toBe('login.success');
    }
  });

  it('by date range, read in the company’s timezone', async () => {
    const today = cairoToday();
    const inRange = await (await api(ADMIN_A)).get(`/audit-logs?from=${today}&to=${today}`);
    expect(inRange.body.meta.total).toBeGreaterThan(0);

    const future = await (await api(ADMIN_A)).get('/audit-logs?from=2099-01-01');
    expect(future.body.data).toEqual([]);

    const past = await (await api(ADMIN_A)).get('/audit-logs?to=2000-01-01');
    expect(past.body.data).toEqual([]);
  });

  it('refuses malformed filters with 422', async () => {
    const admin = await api(ADMIN_A);
    for (const query of [
      'action=not.an_action',
      'user_id=nope',
      'entity_id=nope',
      'entity_type=Bad-Type',
      'from=2026-02-30',
      'from=2026-03-10&to=2026-03-01',
      'company_id=' + COMPANY_B,
    ]) {
      expect((await admin.get(`/audit-logs?${query}`)).status, query).toBe(422);
    }
  });
});

describe('pagination', () => {
  it('pages with the DOCUMENT 08 §2 collection envelope', async () => {
    const first = await (await api(ADMIN_A)).get('/audit-logs?per_page=1&page=1');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.meta).toMatchObject({ page: 1, per_page: 1 });
    expect(first.body.meta.total).toBeGreaterThan(1);
    expect(first.body.meta.total_pages).toBe(first.body.meta.total);

    const second = await (await api(ADMIN_A)).get('/audit-logs?per_page=1&page=2');
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });

  it('caps per_page at 100', async () => {
    expect((await (await api(ADMIN_A)).get('/audit-logs?per_page=101')).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Entity history — DOCUMENT 21 rule 5
// ---------------------------------------------------------------------------

describe('GET /audit-logs/entity/{type}/{id}', () => {
  it('returns one record’s history and nothing else', async () => {
    const response = await (await api(ADMIN_A)).get(`/audit-logs/entity/company/${COMPANY_A}`);
    expect(response.status).toBe(200);
    const entries = response.body.data as Entry[];
    expect(entries.map((entry) => entry.action)).toContain('settings.company_updated');
    for (const entry of entries) {
      expect(entry.entity_type).toBe('company');
      expect(entry.entity_id).toBe(COMPANY_A);
    }
  });

  it('validates the type and the id', async () => {
    const admin = await api(ADMIN_A);
    expect((await admin.get(`/audit-logs/entity/Bad-Type/${COMPANY_A}`)).status).toBe(422);
    expect((await admin.get('/audit-logs/entity/company/not-a-uuid')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Read-only — DOCUMENT 21: "No POST, PATCH, or DELETE endpoints exist"
// ---------------------------------------------------------------------------

describe('read-only', () => {
  it('has no write, update or delete endpoint', async () => {
    const admin = await api(ADMIN_A);
    const listed = await admin.get('/audit-logs?per_page=1');
    const id = (listed.body.data as Entry[])[0]?.id as string;

    expect((await admin.post('/audit-logs').send({ action: 'logout' })).status).toBe(404);
    expect((await admin.put(`/audit-logs/${id}`).send({})).status).toBe(404);
    expect((await admin.patch(`/audit-logs/${id}`).send({ action: 'logout' })).status).toBe(404);
    expect((await admin.delete(`/audit-logs/${id}`)).status).toBe(404);
    expect((await admin.delete(`/audit-logs/entity/company/${COMPANY_A}`)).status).toBe(404);

    const after = await admin.get(`/audit-logs?per_page=1`);
    expect(after.body.data[0].id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// Audit after commit — DOCUMENT 21 "Business rules" §1–§3 and "Audit write
// fails". The shared mechanism (`AuditDispatcher`) is proved directly. Then
// two representative modules prove it end to end: company settings (Phase 4,
// `TenantScopedService`) and login (Phase 3, which opens its own transaction).
// ---------------------------------------------------------------------------

describe('audit is written after commit, never for a rollback, and survives its own failure', () => {
  async function asOwner<T>(run: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe('RESET ROLE');
    try {
      return await run();
    } finally {
      await prisma.$executeRawUnsafe('SET ROLE ufuq_app');
    }
  }

  async function withForcedFailure(
    table: string,
    condition: string,
    run: () => Promise<void>,
  ): Promise<void> {
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

  async function audits(where: { action?: AuditAction; entityId?: string }) {
    return withTenant(prisma, COMPANY_A, (tx) =>
      tx.auditLog.findMany({
        where: {
          ...(where.action === undefined ? {} : { action: where.action }),
          ...(where.entityId === undefined ? {} : { entityId: where.entityId }),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  async function correctionWindow(): Promise<number> {
    const company = await withTenant(prisma, COMPANY_A, (tx) =>
      tx.company.findUniqueOrThrow({
        where: { id: COMPANY_A },
        select: { correctionWindowDays: true },
      }),
    );
    return company.correctionWindowDays;
  }

  function entry(entityId: string) {
    return {
      companyId: COMPANY_A,
      userId: ADMIN_A.id,
      action: 'SETTINGS_COMPANY_UPDATED' as const,
      entityType: 'company',
      entityId,
      newValues: { probe: true },
    };
  }

  beforeEach(() => {
    retryQueue.entries.length = 0;
    retryQueue.failing = false;
  });

  describe('the shared dispatcher', () => {
    it('a transaction that rolls back writes none of the audits recorded in it', async () => {
      const dispatcher = app.get(AuditDispatcher);
      const probe = generateId();
      await expect(
        dispatcher.withTenant(COMPANY_A, async (tx) => {
          await dispatcher.record(tx, entry(probe));
          throw new Error('business failure');
        }),
      ).rejects.toThrow('business failure');
      expect(await audits({ entityId: probe })).toEqual([]);
      expect(retryQueue.entries).toEqual([]);
    });

    it('a transaction that commits gets its audits afterwards, in the order they were recorded', async () => {
      const dispatcher = app.get(AuditDispatcher);
      const probe = generateId();
      let duringTransaction: number | null = null;
      await dispatcher.withTenant(COMPANY_A, async (tx) => {
        await dispatcher.record(tx, { ...entry(probe), newValues: { step: 1 } });
        await dispatcher.record(tx, { ...entry(probe), newValues: { step: 2 } });
        duringTransaction = await tx.auditLog.count({ where: { entityId: probe } });
      });
      expect(duringTransaction).toBe(0);
      expect((await audits({ entityId: probe })).map((row) => row.newValues)).toEqual([
        { step: 1 },
        { step: 2 },
      ]);
    });

    it('refuses to record against a transaction it did not open', async () => {
      const dispatcher = app.get(AuditDispatcher);
      const probe = generateId();
      await expect(
        withTenant(prisma, COMPANY_A, (tx: TenantClient) => dispatcher.record(tx, entry(probe))),
      ).rejects.toThrow(/outside a post-commit scope/);
      expect(await audits({ entityId: probe })).toEqual([]);
    });

    it('a retried write never duplicates the record', async () => {
      const dispatcher = app.get(AuditDispatcher);
      const probe = generateId();
      const queued: QueuedAuditEntry = {
        ...entry(probe),
        id: generateId(),
        occurredAt: new Date().toISOString(),
      };
      await dispatcher.write(queued);
      await dispatcher.write(queued);
      const rows = await audits({ entityId: probe });
      expect(rows.map((row) => row.id)).toEqual([queued.id]);
    });
  });

  describe('company settings (Phase 4)', () => {
    it('a forced business failure rolls back the change and writes no audit', async () => {
      const before = await correctionWindow();
      const recorded = (await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).length;
      await withForcedFailure(
        'companies',
        `TG_OP = 'UPDATE' AND NEW.correction_window_days = 21`,
        async () => {
          const response = await (await api(ADMIN_A))
            .patch('/company')
            .send({ correction_window_days: 21 });
          expect(response.status).toBe(500);
        },
      );
      expect(await correctionWindow()).toBe(before);
      expect(await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).toHaveLength(recorded);
      expect(retryQueue.entries).toEqual([]);
    });

    it('the change is committed before its audit is dispatched, with the canonical action and values', async () => {
      const before = await correctionWindow();
      const recorded = (await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).length;
      const dispatcher = app.get(AuditDispatcher);
      const original = dispatcher.dispatch.bind(dispatcher);
      const seen: { window: number; audits: number }[] = [];
      const spy = vi.spyOn(dispatcher, 'dispatch').mockImplementation(async (entries, at) => {
        // Read from outside the business transaction: only committed state is visible.
        seen.push({
          window: await correctionWindow(),
          audits: (await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).length,
        });
        await original(entries, at);
      });
      try {
        const response = await (await api(ADMIN_A))
          .patch('/company')
          .send({ correction_window_days: 14 });
        expect(response.status).toBe(200);
      } finally {
        spy.mockRestore();
      }
      expect(seen).toEqual([{ window: 14, audits: recorded }]);
      const written = await audits({ action: 'SETTINGS_COMPANY_UPDATED' });
      expect(written).toHaveLength(recorded + 1);
      expect(written[written.length - 1]).toMatchObject({
        userId: ADMIN_A.id,
        entityType: 'company',
        entityId: COMPANY_A,
        oldValues: { correction_window_days: before },
        newValues: { correction_window_days: 14 },
      });
    });

    it('a failed audit write keeps the committed change, queues the entry, and the retry lands once', async () => {
      const recorded = (await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).length;
      await withForcedFailure('audit_logs', `NEW.action = 'settings.company_updated'`, async () => {
        const response = await (await api(ADMIN_A))
          .patch('/company')
          .send({ correction_window_days: 9 });
        expect(response.status).toBe(200);
      });
      expect(await correctionWindow()).toBe(9);
      expect(await audits({ action: 'SETTINGS_COMPANY_UPDATED' })).toHaveLength(recorded);
      expect(retryQueue.entries).toHaveLength(1);
      const queued = retryQueue.entries[0] as QueuedAuditEntry;
      expect(queued).toMatchObject({
        action: 'SETTINGS_COMPANY_UPDATED',
        entityId: COMPANY_A,
        newValues: { correction_window_days: 9 },
      });

      const dispatcher = app.get(AuditDispatcher);
      await dispatcher.write(queued);
      await dispatcher.write(queued);
      const written = await audits({ action: 'SETTINGS_COMPANY_UPDATED' });
      expect(written).toHaveLength(recorded + 1);
      expect(written.filter((row) => row.id === queued.id)).toHaveLength(1);
    });
  });

  describe('login (Phase 3)', () => {
    it('a failed login.success audit never fails the login; the entry goes to the fallback log if the queue is down', async () => {
      retryQueue.failing = true;
      const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const recorded = (await audits({ action: 'LOGIN_SUCCESS', entityId: ADMIN_A.id })).length;
      try {
        await withForcedFailure(
          'audit_logs',
          `NEW.action = 'login.success' AND NEW.entity_id = '${ADMIN_A.id}'::uuid`,
          async () => {
            redis.reset();
            const response = await request(server())
              .post(`/${API_PREFIX}/auth/login`)
              .set('X-Client-Type', 'mobile')
              .send({ email: ADMIN_A.email, password: ADMIN_A.password });
            expect(response.status).toBe(200);
            expect(typeof response.body.data.accessToken).toBe('string');
          },
        );
        const fallback = errors.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith('AUDIT_FALLBACK'));
        expect(fallback).toHaveLength(1);
        expect(fallback[0]).toContain('LOGIN_SUCCESS');
        expect(fallback[0]).not.toContain(ADMIN_A.password);
      } finally {
        errors.mockRestore();
      }
      expect(await audits({ action: 'LOGIN_SUCCESS', entityId: ADMIN_A.id })).toHaveLength(
        recorded,
      );
    });
  });
});
