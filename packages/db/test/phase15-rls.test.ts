/**
 * Phase 15 row-level security and notification guarantees — AD-03, DOCUMENT
 * 06 §3.34, DOCUMENT 19 "Validation", "Database requirements" and rule 8,
 * DOCUMENT 26 §5.
 *
 * The real migrations on PGlite, as the restricted `ufuq_app` role. New in
 * Phase 15: `notifications` (tenant-isolated; the recipient an active user
 * of the same company; recipient, type and source never change; hard delete
 * permitted for retention), `notification_events` (one row per company and
 * event key; never updated) and `company_notification_settings`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const MIGRATION_NAMES = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function migrationSql(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`${name}/migration.sql`, `file://${MIGRATIONS_DIRECTORY}`)),
    'utf8',
  );
}

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

function ids(prefix: string) {
  return {
    user: `00000000-0000-7000-8000-${prefix}a1`,
    inactive: `00000000-0000-7000-8000-${prefix}a2`,
    notification: `00000000-0000-7000-8000-${prefix}b1`,
    event: `00000000-0000-7000-8000-${prefix}b2`,
  } as const;
}

const IDS = { [COMPANY_A]: ids('0000000001'), [COMPANY_B]: ids('0000000002') } as const;
const A = IDS[COMPANY_A];
const B = IDS[COMPANY_B];

let db: PGlite;

async function asOwner(companyId: string, sql: string): Promise<void> {
  await db.exec(`SELECT set_config('app.company_id', '${companyId}', false);\n${sql}`);
}

async function asApp<T>(companyId: string, sql: string): Promise<T[]> {
  await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '${companyId}', false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function expectRejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the database to reject the statement');
}

function notificationInsert(
  companyId: string,
  o: {
    id: string;
    user: string;
    type?: string;
    relatedId?: string | null;
    groupCount?: number;
    createdAt?: string;
  },
): string {
  const related = o.relatedId === null ? 'NULL' : `'${o.relatedId ?? o.id}'`;
  return `INSERT INTO notifications (id, company_id, user_id, type, priority, audience,
            title_ar, title_en, body_ar, body_en, related_type, related_id, group_count, created_at)
          VALUES ('${o.id}', '${companyId}', '${o.user}', '${o.type ?? 'task_assigned'}', 'high',
            'employee', 'مهمة جديدة', 'New task', 'أُسندت إليك مهمة.', 'A task was assigned.',
            'task', ${related}, ${String(o.groupCount ?? 1)}, ${o.createdAt ?? 'now()'})`;
}

async function seedCompany(companyId: string, slug: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
  await asOwner(
    companyId,
    `INSERT INTO companies (id, name, slug, timezone, updated_at)
       VALUES ('${companyId}', '${slug}', '${slug}', 'Africa/Cairo', now());
     INSERT INTO users (id, company_id, email, role_id, status, updated_at)
       VALUES ('${own.user}', '${companyId}', 'user@${slug}.test', '${ROLE}', 'active', now()),
              ('${own.inactive}', '${companyId}', 'gone@${slug}.test', '${ROLE}', 'deactivated', now());
     INSERT INTO notification_events (id, company_id, event_key, event_type)
       VALUES ('${own.event}', '${companyId}', 'task_assigned:x', 'task_assigned');
     ${notificationInsert(companyId, { id: own.notification, user: own.user })};
     INSERT INTO company_notification_settings (company_id, type, channel, enabled, updated_by)
       VALUES ('${companyId}', 'task_updated', 'in_app', false, '${own.user}');`,
  );
}

describe('with every migration applied', () => {
  beforeEach(async () => {
    db = new PGlite();
    for (const name of MIGRATION_NAMES) await db.exec(migrationSql(name));
    await db.exec(
      `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
       VALUES ('${ROLE}', NULL, 'admin', 'Admin', 'مدير', true, now());`,
    );
    await seedCompany(COMPANY_A, 'company-a');
    await seedCompany(COMPANY_B, 'company-b');
  });

  afterEach(async () => {
    await db.close();
  });

  describe('tenant isolation (AD-03)', () => {
    for (const table of ['notifications', 'notification_events', 'company_notification_settings']) {
      it(`${table}: a company sees only its own rows`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.map((r) => r.company_id)).toEqual([COMPANY_A]);
      });
    }

    it('another company’s notification can be neither read, updated nor deleted', async () => {
      expect(
        await asApp(
          COMPANY_A,
          `UPDATE notifications SET read_at = now() WHERE id = '${B.notification}' RETURNING id`,
        ),
      ).toEqual([]);
      expect(
        await asApp(
          COMPANY_A,
          `DELETE FROM notifications WHERE id = '${B.notification}' RETURNING id`,
        ),
      ).toEqual([]);
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            notificationInsert(COMPANY_B, {
              id: '00000000-0000-7000-8000-0000000099c1',
              user: B.user,
            }),
          ),
        ),
      ).toMatch(/row-level security|active user of the same company/);
    });
  });

  describe('DOCUMENT 19 "Validation"', () => {
    it('the recipient must be an active user of the same company', async () => {
      // Another company's user.
      expect(
        await expectRejection(() =>
          asOwner(
            COMPANY_A,
            notificationInsert(COMPANY_A, {
              id: '00000000-0000-7000-8000-0000000099c2',
              user: B.user,
            }),
          ),
        ),
      ).toMatch(/active user of the same company/);
      // A deactivated user.
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            notificationInsert(COMPANY_A, {
              id: '00000000-0000-7000-8000-0000000099c3',
              user: A.inactive,
            }),
          ),
        ),
      ).toMatch(/active user of the same company/);
    });

    it('a notification created before the user was deactivated is kept', async () => {
      await asOwner(COMPANY_A, `UPDATE users SET status = 'deactivated' WHERE id = '${A.user}'`);
      const rows = await asApp<{ id: string }>(COMPANY_A, `SELECT id FROM notifications`);
      expect(rows.map((r) => r.id)).toEqual([A.notification]);
    });

    it('the type must be a known value', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            notificationInsert(COMPANY_A, {
              id: '00000000-0000-7000-8000-0000000099c4',
              user: A.user,
              type: 'salary_amount',
            }),
          ),
        ),
      ).toMatch(/invalid input value for enum/);
    });

    it('every notification links to a source; only a summary may link to a list', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            notificationInsert(COMPANY_A, {
              id: '00000000-0000-7000-8000-0000000099c5',
              user: A.user,
              relatedId: null,
            }),
          ),
        ),
      ).toMatch(/notifications_has_source/);
      expect(
        await asApp(
          COMPANY_A,
          `${notificationInsert(COMPANY_A, {
            id: '00000000-0000-7000-8000-0000000099c6',
            user: A.user,
            relatedId: null,
            groupCount: 4,
          })} RETURNING id`,
        ),
      ).toHaveLength(1);
    });
  });

  describe('integrity', () => {
    it('reading and handling are allowed; recipient, type and source never change', async () => {
      expect(
        await asApp(
          COMPANY_A,
          `UPDATE notifications SET read_at = now(), handled_at = now() RETURNING id`,
        ),
      ).toHaveLength(1);
      for (const sql of [
        `UPDATE notifications SET user_id = '${A.inactive}'`,
        `UPDATE notifications SET type = 'task_updated'`,
        `UPDATE notifications SET related_type = 'goal'`,
      ]) {
        expect(await expectRejection(() => asApp(COMPANY_A, sql))).toMatch(/never change/);
      }
    });

    it('one processed event per company and key; the ledger is never updated', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `INSERT INTO notification_events (id, company_id, event_key, event_type)
             VALUES ('00000000-0000-7000-8000-0000000099c7', '${COMPANY_A}', 'task_assigned:x', 'task_assigned')`,
          ),
        ),
      ).toMatch(/notification_events_company_id_event_key_key|unique/);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE notification_events SET event_type = 'x'`),
        ),
      ).toMatch(/permission denied/);
    });

    it('retention may hard-delete notifications and processed events; settings are never deleted', async () => {
      expect(await asApp(COMPANY_A, `DELETE FROM notifications RETURNING id`)).toHaveLength(1);
      expect(await asApp(COMPANY_A, `DELETE FROM notification_events RETURNING id`)).toHaveLength(
        1,
      );
      expect(
        await expectRejection(() => asApp(COMPANY_A, `DELETE FROM company_notification_settings`)),
      ).toMatch(/permission denied/);
    });

    it('the unread badge and list index exists', async () => {
      const rows = await asApp<{ indexdef: string }>(
        COMPANY_A,
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'notifications_user_id_read_at_created_at_idx'`,
      );
      expect(rows[0]?.indexdef).toMatch(/\(user_id, read_at, created_at\)/);
    });
  });
});
