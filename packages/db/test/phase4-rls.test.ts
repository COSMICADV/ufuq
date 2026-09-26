/**
 * Phase 4 row-level security — AD-03, DOCUMENT 20 §3, DOCUMENT 26 §5.
 *
 * The Phase 3 exit criterion — "the tenancy scope cannot be bypassed by
 * omitting a `where` clause" — is not a one-time achievement. Every table a
 * later phase adds has to earn it again, so this file does for the five
 * company-structure tables exactly what `rls.test.ts` did for the
 * authentication tables: runs the real migration files (not a paraphrase of
 * them) against a real PostgreSQL engine (`@electric-sql/pglite` is Postgres
 * compiled to WASM, not a mock), acts as the restricted `ufuq_app` role the
 * API actually runs as, and queries with **no `WHERE` clause at all**.
 *
 * `work_schedule_days` gets its own attention: it carries no `company_id`, so
 * its policy walks the foreign key to its schedule. That indirection is the
 * one place in this phase where isolation could plausibly be got wrong, which
 * is why it is asserted from both directions — read and write.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url)),
    'utf8',
  );
}

const PHASE3_SQL = migration('20260101000000_phase3_auth_and_tenancy');
const PHASE4_SQL = migration('20260908000000_phase4_company_structure');

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const DEPT_A = '00000000-0000-7000-8000-0000000000d1';
const DEPT_B = '00000000-0000-7000-8000-0000000000d2';
const SCHEDULE_A = '00000000-0000-7000-8000-0000000000e1';
const SCHEDULE_B = '00000000-0000-7000-8000-0000000000e2';

let db: PGlite;

/** Run SQL as the owner, with `app.company_id` bound to `companyId`. */
async function asOwner(companyId: string, sql: string): Promise<void> {
  await db.exec(`SELECT set_config('app.company_id', '${companyId}', false);\n${sql}`);
}

/** Run one query as `ufuq_app` with the tenant bound, exactly as `withTenant` does. */
async function asApp<T>(companyId: string, sql: string): Promise<T[]> {
  await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '${companyId}', false);`);
  try {
    const result = await db.query<T>(sql);
    return result.rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function expectRejection(companyId: string, sql: string): Promise<string> {
  try {
    await asApp(companyId, sql);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`Expected the database to reject: ${sql}`);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(PHASE3_SQL);
  await db.exec(PHASE4_SQL);

  for (const [id, slug] of [
    [COMPANY_A, 'company-a'],
    [COMPANY_B, 'company-b'],
  ] as const) {
    await asOwner(
      id,
      `INSERT INTO companies (id, name, slug, timezone, created_at, updated_at)
       VALUES ('${id}', '${slug}', '${slug}', 'Africa/Cairo', now(), now());`,
    );
  }

  for (const [company, dept, schedule] of [
    [COMPANY_A, DEPT_A, SCHEDULE_A],
    [COMPANY_B, DEPT_B, SCHEDULE_B],
  ] as const) {
    await asOwner(
      company,
      `INSERT INTO departments (id, company_id, name_ar, name_en, updated_at)
         VALUES ('${dept}', '${company}', 'قسم ${dept.slice(-2)}', 'Dept ${dept.slice(-2)}', now());
       INSERT INTO positions (id, company_id, title_ar, title_en, department_id, updated_at)
         VALUES (gen_random_uuid(), '${company}', 'مسمى', 'Title', '${dept}', now());
       INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
         VALUES ('${schedule}', '${company}', 'Schedule', 'Africa/Cairo', 4.00, now());
       INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, start_time, end_time, updated_at)
         VALUES (gen_random_uuid(), '${schedule}', 0, true, '09:00', '17:00', now());
       INSERT INTO holidays (id, company_id, date, name_ar, name_en, updated_at)
         VALUES (gen_random_uuid(), '${company}', DATE '2026-01-07', 'عيد', 'Holiday', now());`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('tenant isolation with no WHERE clause — DOCUMENT 25 Phase 3 exit criterion', () => {
  it.each([
    ['departments', 'SELECT id FROM departments'],
    ['positions', 'SELECT id FROM positions'],
    ['work_schedules', 'SELECT id FROM work_schedules'],
    ['holidays', 'SELECT id FROM holidays'],
    ['work_schedule_days', 'SELECT id FROM work_schedule_days'],
  ])('%s returns only the bound tenant’s rows', async (_table, sql) => {
    const seenByA = await asApp<{ id: string }>(COMPANY_A, sql);
    const seenByB = await asApp<{ id: string }>(COMPANY_B, sql);

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(1);
    expect(seenByA[0]?.id).not.toBe(seenByB[0]?.id);
  });

  it('a cross-tenant UPDATE matches nothing rather than rewriting the other company', async () => {
    // No WHERE clause naming a company: the policy is the only thing standing
    // between this statement and every department in the database.
    await asApp(COMPANY_A, `UPDATE departments SET name_en = 'Renamed'`);

    const [rowB] = await asApp<{ name_en: string }>(COMPANY_B, 'SELECT name_en FROM departments');
    expect(rowB?.name_en).toBe('Dept d2');
  });

  it('a cross-tenant DELETE removes nothing', async () => {
    await asApp(COMPANY_A, 'DELETE FROM holidays');

    const remainingForB = await asApp(COMPANY_B, 'SELECT id FROM holidays');
    expect(remainingForB).toHaveLength(1);
  });

  it('an INSERT naming another company is refused by WITH CHECK', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO departments (id, company_id, name_ar, name_en, updated_at)
       VALUES (gen_random_uuid(), '${COMPANY_B}', 'مقحم', 'Injected', now())`,
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('no tenant bound at all means no company-structure row is visible', async () => {
    // The empty string is what `withPlatformContext` binds: RLS then matches
    // nothing, which is why the pre-authentication `auth_lookup_*` functions
    // in the Phase 3 migration have to be SECURITY DEFINER to work at all.
    const rows = await asApp('', 'SELECT id FROM departments');
    expect(rows).toHaveLength(0);
  });
});

describe('work_schedule_days — isolation through the parent schedule', () => {
  it('cannot be read across tenants even though the row has no company_id', async () => {
    const rows = await asApp<{ work_schedule_id: string }>(
      COMPANY_A,
      'SELECT work_schedule_id FROM work_schedule_days',
    );
    expect(rows).toEqual([{ work_schedule_id: SCHEDULE_A }]);
  });

  it('cannot be inserted under another company’s schedule', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, updated_at)
       VALUES (gen_random_uuid(), '${SCHEDULE_B}', 3, false, now())`,
    );
    // Either the policy or the foreign key may speak first — the parent is
    // invisible to this role, so both are correct refusals of the same thing.
    expect(message).toMatch(/row-level security|foreign key/i);
  });

  it('cannot be updated across tenants with no WHERE clause', async () => {
    await asApp(COMPANY_A, 'UPDATE work_schedule_days SET day_of_week = 5');

    const [dayB] = await asApp<{ day_of_week: number }>(
      COMPANY_B,
      'SELECT day_of_week FROM work_schedule_days',
    );
    expect(dayB?.day_of_week).toBe(0);
  });
});

describe('database-level integrity the service layer must not be the only guard for', () => {
  it('refuses a working day with no times', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, updated_at)
       VALUES (gen_random_uuid(), '${SCHEDULE_A}', 1, true, now())`,
    );
    expect(message).toMatch(/work_schedule_days_time_shape/);
  });

  it('refuses a non-working day that still carries times', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, start_time, end_time, updated_at)
       VALUES (gen_random_uuid(), '${SCHEDULE_A}', 2, false, '09:00', '17:00', now())`,
    );
    expect(message).toMatch(/work_schedule_days_time_shape/);
  });

  it('refuses an end time that is not after the start time', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedule_days (id, work_schedule_id, day_of_week, is_working_day, start_time, end_time, updated_at)
       VALUES (gen_random_uuid(), '${SCHEDULE_A}', 3, true, '17:00', '09:00', now())`,
    );
    expect(message).toMatch(/work_schedule_days_time_shape/);
  });

  it('refuses a second default schedule for the same company', async () => {
    await asApp(COMPANY_A, `UPDATE work_schedules SET is_default = true`);
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, is_default, updated_at)
       VALUES (gen_random_uuid(), '${COMPANY_A}', 'Second', 'Africa/Cairo', 4.00, true, now())`,
    );
    expect(message).toMatch(/work_schedules_one_default_per_company/);
  });

  it('lets each company hold its own default schedule', async () => {
    await asApp(COMPANY_A, `UPDATE work_schedules SET is_default = true`);
    await asApp(COMPANY_B, `UPDATE work_schedules SET is_default = true`);

    const defaultsForB = await asApp(COMPANY_B, 'SELECT id FROM work_schedules WHERE is_default');
    expect(defaultsForB).toHaveLength(1);
  });

  it('refuses a duplicate holiday date within one company', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO holidays (id, company_id, date, name_ar, name_en, updated_at)
       VALUES (gen_random_uuid(), '${COMPANY_A}', DATE '2026-01-07', 'مكرر', 'Duplicate', now())`,
    );
    expect(message).toMatch(/holidays_company_id_date_key/);
  });

  it('lets two companies hold the same holiday date', async () => {
    // Already seeded identically for both tenants in `beforeEach` — the fact
    // that setup succeeded is the assertion; this confirms both survived.
    const forA = await asApp(COMPANY_A, `SELECT id FROM holidays`);
    const forB = await asApp(COMPANY_B, `SELECT id FROM holidays`);
    expect([forA.length, forB.length]).toEqual([1, 1]);
  });

  it('refuses a department that is its own parent', async () => {
    const message = await expectRejection(COMPANY_A, `UPDATE departments SET parent_id = id`);
    expect(message).toMatch(/departments_parent_not_self/);
  });

  it('refuses a half-day threshold outside a single day', async () => {
    const message = await expectRejection(
      COMPANY_A,
      `INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
       VALUES (gen_random_uuid(), '${COMPANY_A}', 'Too long', 'Africa/Cairo', 25.00, now())`,
    );
    expect(message).toMatch(/work_schedules_half_day_within_a_day/);
  });
});
