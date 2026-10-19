/**
 * Phase 12 row-level security and snapshot guarantees — AD-03, DOCUMENT 06
 * §3.27, DOCUMENT 18 rules 1–2, DOCUMENT 26 §5.
 *
 * The real migrations on PGlite, as the restricted `ufuq_app` role. New in
 * Phase 12: `monthly_employee_reports` (tenant-isolated, one per employee and
 * month, same-company references, never deleted, and changed only by an
 * explicit regeneration that raises the revision) and `report_exports`.
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
const FINGERPRINT = 'a'.repeat(64);

function ids(prefix: string) {
  return {
    user: `00000000-0000-7000-8000-${prefix}a1`,
    schedule: `00000000-0000-7000-8000-${prefix}a2`,
    employee: `00000000-0000-7000-8000-${prefix}a3`,
    report: `00000000-0000-7000-8000-${prefix}b1`,
    export: `00000000-0000-7000-8000-${prefix}b2`,
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

function reportInsert(
  companyId: string,
  o: { id: string; employee: string; user: string; month?: number },
): string {
  return `INSERT INTO monthly_employee_reports (id, company_id, employee_id, year, month,
            attendance_summary, task_summary, goal_summary, salary_summary, performance_scores,
            overall_score, generated_at, generated_by, is_provisional, source_fingerprint)
          VALUES ('${o.id}', '${companyId}', '${o.employee}', 2026, ${String(o.month ?? 9)},
            '{}', '{}', '{}', '{}', '{}', 88.50, now(), '${o.user}', false, '${FINGERPRINT}')`;
}

async function seedCompany(companyId: string, slug: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
  await asOwner(
    companyId,
    `INSERT INTO companies (id, name, slug, timezone, updated_at)
       VALUES ('${companyId}', '${slug}', '${slug}', 'Africa/Cairo', now());
     INSERT INTO users (id, company_id, email, role_id, updated_at)
       VALUES ('${own.user}', '${companyId}', 'admin@${slug}.test', '${ROLE}', now());
     INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
       VALUES ('${own.schedule}', '${companyId}', 'Schedule', 'Africa/Cairo', 4.00, now());
     INSERT INTO employees (id, company_id, user_id, employee_code, first_name, last_name,
          work_schedule_id, joining_date, updated_at)
       VALUES ('${own.employee}', '${companyId}', '${own.user}', 'EMP-001', 'First', 'Last',
          '${own.schedule}', DATE '2026-01-15', now());
     ${reportInsert(companyId, { id: own.report, employee: own.employee, user: own.user })};
     INSERT INTO report_exports (id, company_id, requested_by, report_key, format, filters, scope, locale)
       VALUES ('${own.export}', '${companyId}', '${own.user}', 'stock-movements', 'csv', '{}', '{}', 'ar');`,
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
    for (const table of ['monthly_employee_reports', 'report_exports']) {
      it(`${table}: a company sees only its own rows and cannot touch another's`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.map((r) => r.company_id)).toEqual([COMPANY_A]);
        expect(
          await asApp(
            COMPANY_A,
            `UPDATE ${table} SET updated_at = now() WHERE company_id = '${COMPANY_B}' RETURNING id`,
          ),
        ).toEqual([]);
      });
    }

    it('a snapshot cannot be written into another company', async () => {
      // Refused either way: the same-company trigger cannot see B's employee
      // through A's row-level security, and the policy's WITH CHECK refuses B.
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            reportInsert(COMPANY_B, {
              id: '00000000-0000-7000-8000-0000000099f1',
              employee: B.employee,
              user: B.user,
              month: 8,
            }),
          ),
        ),
      ).toMatch(/row-level security|same company/);
    });

    it('a snapshot or an export cannot reference another company’s employee or user', async () => {
      for (const sql of [
        reportInsert(COMPANY_A, {
          id: '00000000-0000-7000-8000-0000000099f2',
          employee: B.employee,
          user: A.user,
          month: 8,
        }),
        reportInsert(COMPANY_A, {
          id: '00000000-0000-7000-8000-0000000099f3',
          employee: A.employee,
          user: B.user,
          month: 8,
        }),
        `INSERT INTO report_exports (id, company_id, requested_by, report_key, format, filters, scope, locale)
           VALUES ('00000000-0000-7000-8000-0000000099f4', '${COMPANY_A}', '${B.user}', 'tasks', 'csv', '{}', '{}', 'en')`,
      ]) {
        expect(await expectRejection(() => asOwner(COMPANY_A, sql))).toMatch(/same company/);
      }
    });
  });

  describe('snapshot integrity (DOCUMENT 18 rules 1–2)', () => {
    it('one snapshot per employee and month', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            reportInsert(COMPANY_A, {
              id: '00000000-0000-7000-8000-0000000099f5',
              employee: A.employee,
              user: A.user,
            }),
          ),
        ),
      ).toMatch(/monthly_employee_reports_employee_id_year_month_key|unique/);
    });

    it('an update that is not a regeneration is refused, for the owner too', async () => {
      for (const run of [
        // A silent rewrite: same revision.
        () =>
          asApp(COMPANY_A, `UPDATE monthly_employee_reports SET overall_score = 10 RETURNING id`),
        () => asOwner(COMPANY_A, `UPDATE monthly_employee_reports SET task_summary = '{"x":1}'`),
        // A revision jump.
        () =>
          asApp(
            COMPANY_A,
            `UPDATE monthly_employee_reports SET revision = 3, generated_at = now() + interval '1 hour'`,
          ),
        // The right revision but no new generation time.
        () =>
          asApp(
            COMPANY_A,
            `UPDATE monthly_employee_reports SET revision = 2, generated_at = generated_at`,
          ),
      ]) {
        expect(await expectRejection(run)).toMatch(/regeneration/);
      }
    });

    it('a regeneration (next revision, later generation time) is accepted', async () => {
      const rows = await asApp<{ revision: number; overall_score: string }>(
        COMPANY_A,
        `UPDATE monthly_employee_reports
            SET revision = revision + 1, generated_at = now() + interval '1 hour', overall_score = 91.25
          RETURNING revision, overall_score`,
      );
      expect(rows).toEqual([{ revision: 2, overall_score: '91.25' }]);
    });

    it('a snapshot cannot move to another month or employee', async () => {
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `UPDATE monthly_employee_reports
                SET month = 10, revision = 2, generated_at = now() + interval '1 hour'`,
          ),
        ),
      ).toMatch(/another employee or month/);
    });

    it('rejects an impossible month, score or fingerprint', async () => {
      for (const sql of [
        reportInsert(COMPANY_A, {
          id: '00000000-0000-7000-8000-0000000099f6',
          employee: A.employee,
          user: A.user,
          month: 13,
        }),
        `UPDATE monthly_employee_reports SET overall_score = 100.01, revision = 2, generated_at = now() + interval '1 hour'`,
        `UPDATE monthly_employee_reports SET source_fingerprint = '${'Z'.repeat(64)}', revision = 2, generated_at = now() + interval '1 hour'`,
      ]) {
        expect(await expectRejection(() => asApp(COMPANY_A, sql))).toMatch(/violates check/);
      }
    });

    it('snapshots and exports are never deleted — no grant for the app, a trigger for the owner', async () => {
      for (const table of ['monthly_employee_reports', 'report_exports']) {
        expect(await expectRejection(() => asApp(COMPANY_A, `DELETE FROM ${table}`))).toMatch(
          /permission denied/,
        );
        expect(await expectRejection(() => asOwner(COMPANY_A, `DELETE FROM ${table}`))).toMatch(
          /never deleted/,
        );
      }
    });
  });

  describe('report_exports', () => {
    it('a completed export names its file and row count; a failed one its reason', async () => {
      for (const sql of [
        `UPDATE report_exports SET status = 'completed'`,
        `UPDATE report_exports SET status = 'failed'`,
        `UPDATE report_exports SET report_key = 'salaries'`,
        `UPDATE report_exports SET format = 'pdf'`,
      ]) {
        expect(await expectRejection(() => asApp(COMPANY_A, sql))).toMatch(/violates check/);
      }
      const done = await asApp<{ status: string }>(
        COMPANY_A,
        `UPDATE report_exports SET status = 'completed', storage_key = 'k', row_count = 3 RETURNING status`,
      );
      expect(done).toEqual([{ status: 'completed' }]);
    });
  });
});
