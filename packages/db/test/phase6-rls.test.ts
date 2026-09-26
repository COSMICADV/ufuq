/**
 * Phase 6 row-level security and reference integrity — AD-03, DOCUMENT 06
 * §3.10–3.11, DOCUMENT 07 §9 invariant 7, DOCUMENT 26 §5.
 *
 * Same approach as `phase5-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind here is the set of table-level guarantees attendance
 * carries beyond tenancy — the one-record-per-day constraint that makes a
 * double check-in a clean conflict, the CHECK constraints that keep a derived
 * row coherent, and the absence of DELETE on a table DOCUMENT 12 says is
 * never hard-deleted.
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

const MIGRATIONS = [
  migration('20260101000000_phase3_auth_and_tenancy'),
  migration('20260908000000_phase4_company_structure'),
  migration('20260913000000_phase5_employees'),
  migration('20260923000000_phase6_attendance'),
  migration('20260924000000_phase6_correction_window_and_system_actor'),
  migration('20260926000000_phase6_nightly_company_enumeration'),
  migration('20260927000000_platform_lookup_search_path'),
];

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';
/** `withPlatformContext`'s binding: `app.company_id` set to the empty string. */
const NO_TENANT = '';

const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
    record: '00000000-0000-7000-8000-0000000001c1',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    record: '00000000-0000-7000-8000-0000000002c2',
  },
} as const;

const A = IDS[COMPANY_A];
const B = IDS[COMPANY_B];

let db: PGlite;

async function asOwner(companyId: string, sql: string): Promise<void> {
  await db.exec(`SELECT set_config('app.company_id', '${companyId}', false);\n${sql}`);
}

async function asApp<T>(companyId: string, sql: string): Promise<T[]> {
  await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '${companyId}', false);`);
  try {
    const result = await db.query<T>(sql);
    return result.rows;
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

function insertRecord(
  companyId: string,
  overrides: Partial<{
    id: string;
    employee: string;
    date: string;
    status: string;
    source: string;
    createdBy: string;
    mode: string;
    checkIn: string;
    checkOut: string;
    working: string;
    overtime: string;
    late: string;
  }> = {},
): string {
  const own = IDS[companyId as keyof typeof IDS];
  const value = (v: string | undefined): string => (v === undefined ? 'NULL' : `'${v}'`);
  const num = (v: string | undefined): string => v ?? 'NULL';
  return `INSERT INTO attendance_records
            (id, company_id, employee_id, date, work_mode, check_in_at, check_out_at,
             working_minutes, overtime_minutes, late_minutes, status, source, created_by, updated_at)
          VALUES ('${overrides.id ?? '00000000-0000-7000-8000-00000000ffff'}', '${companyId}',
            '${overrides.employee ?? own.employee}', DATE '${overrides.date ?? '2026-03-02'}',
            ${value(overrides.mode)}, ${overrides.checkIn ? `TIMESTAMPTZ '${overrides.checkIn}'` : 'NULL'},
            ${overrides.checkOut ? `TIMESTAMPTZ '${overrides.checkOut}'` : 'NULL'},
            ${num(overrides.working)}, ${num(overrides.overtime)}, ${num(overrides.late)},
            '${overrides.status ?? 'present'}', '${overrides.source ?? 'self'}',
            ${value(overrides.createdBy)}, now())`;
}

beforeEach(async () => {
  db = new PGlite();
  for (const sql of MIGRATIONS) {
    await db.exec(sql);
  }

  await db.exec(
    `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
     VALUES ('${ROLE}', NULL, 'employee', 'Employee', 'موظف', true, now());`,
  );

  for (const [companyId, slug] of [
    [COMPANY_A, 'company-a'],
    [COMPANY_B, 'company-b'],
  ] as const) {
    const own = IDS[companyId];
    await asOwner(
      companyId,
      `INSERT INTO companies (id, name, slug, timezone, updated_at)
         VALUES ('${companyId}', '${slug}', '${slug}', 'Africa/Cairo', now());
       INSERT INTO users (id, company_id, email, role_id, updated_at)
         VALUES ('${own.user}', '${companyId}', 'person@${slug}.test', '${ROLE}', now());
       INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
         VALUES ('${own.schedule}', '${companyId}', 'Schedule', 'Africa/Cairo', 4.00, now());
       INSERT INTO employees (id, company_id, user_id, employee_code, first_name, last_name,
            work_schedule_id, joining_date, updated_at)
         VALUES ('${own.employee}', '${companyId}', '${own.user}', 'EMP-001', 'First', 'Last',
            '${own.schedule}', DATE '2026-01-15', now());
       ${insertRecord(companyId, { id: own.record, mode: 'office' })};`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('attendance_records — tenant isolation', () => {
  it('a bare SELECT returns only the caller company’s rows', async () => {
    const rows = await asApp<{ company_id: string }>(COMPANY_A, 'SELECT * FROM attendance_records');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(COMPANY_A);

    const other = await asApp<{ company_id: string }>(
      COMPANY_B,
      'SELECT * FROM attendance_records',
    );
    expect(other).toHaveLength(1);
    expect(other[0]?.company_id).toBe(COMPANY_B);
  });

  it('naming another company’s record by primary key still finds nothing', async () => {
    const rows = await asApp(
      COMPANY_A,
      `SELECT * FROM attendance_records WHERE id = '${B.record}'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to insert a row for another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertRecord(COMPANY_B, { id: '00000000-0000-7000-8000-00000000aaaa' })),
    );
    // Refused by the same-company trigger rather than by the policy's WITH
    // CHECK, because the trigger fires first and its own lookup is itself
    // row-secured: asked about company B's employee while `app.company_id` is
    // company A, it cannot see that employee and says so. Both guards refuse
    // the write; the trigger simply reaches it first. The policy is proved
    // independently by the bare SELECT and UPDATE tests around this one.
    expect(message).toMatch(/row-level security|policy|same company/i);
  });

  it('an UPDATE with no WHERE cannot reach another company’s row', async () => {
    await asApp(COMPANY_A, "UPDATE attendance_records SET note = 'touched'");
    const other = await asApp<{ note: string | null }>(
      COMPANY_B,
      'SELECT note FROM attendance_records',
    );
    expect(other[0]?.note).toBeNull();
  });

  it('cannot move a row into another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE attendance_records SET company_id = '${COMPANY_B}'`),
    );
    expect(message).toMatch(/row-level security|policy|same company/i);
  });
});

describe('attendance_correction_requests — tenant isolation', () => {
  const insertCorrection = (companyId: string, employee: string, id: string): string =>
    `INSERT INTO attendance_correction_requests
       (id, company_id, employee_id, date, reason, updated_at)
     VALUES ('${id}', '${companyId}', '${employee}', DATE '2026-03-02', 'Forgot to check out', now())`;

  it('a bare SELECT returns only the caller company’s rows', async () => {
    await asApp(
      COMPANY_A,
      insertCorrection(COMPANY_A, A.employee, '00000000-0000-7000-8000-0000000011a1'),
    );
    await asApp(
      COMPANY_B,
      insertCorrection(COMPANY_B, B.employee, '00000000-0000-7000-8000-0000000011b1'),
    );

    const rows = await asApp<{ company_id: string }>(
      COMPANY_A,
      'SELECT * FROM attendance_correction_requests',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(COMPANY_A);
  });

  it('refuses a correction for another company', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertCorrection(COMPANY_B, B.employee, '00000000-0000-7000-8000-0000000011c1'),
      ),
    );
    // Same ordering as the record above: the trigger refuses it first.
    expect(message).toMatch(/row-level security|policy|same company/i);
  });
});

describe('same-company triggers — a foreign key alone is not enough', () => {
  it('refuses a record whose employee belongs to another company, for the app role', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertRecord(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000dddd',
          employee: B.employee,
        }),
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('refuses it for the owner too, who bypasses row-level security entirely', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertRecord(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000eeee',
          employee: B.employee,
        }),
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('refuses a created_by naming another company’s user', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertRecord(COMPANY_A, { id: '00000000-0000-7000-8000-00000000cccc', createdBy: B.user }),
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('refuses a correction pointing at another company’s record', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `INSERT INTO attendance_correction_requests
           (id, company_id, employee_id, attendance_record_id, date, reason, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000012a1', '${COMPANY_A}', '${A.employee}',
           '${B.record}', DATE '2026-03-02', 'Wrong company', now())`,
      ),
    );
    expect(message).toMatch(/same company/i);
  });
});

describe('one record per employee per day — DOCUMENT 12 rule 1', () => {
  it('a second record for the same employee and date is refused', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertRecord(COMPANY_A, { id: '00000000-0000-7000-8000-00000000bbbb', date: '2026-03-02' }),
      ),
    );
    expect(message).toMatch(/unique|duplicate/i);
  });

  it('the same employee on a different date is fine', async () => {
    await asApp(
      COMPANY_A,
      insertRecord(COMPANY_A, { id: '00000000-0000-7000-8000-00000000bbbc', date: '2026-03-03' }),
    );
    const rows = await asApp(COMPANY_A, 'SELECT * FROM attendance_records');
    expect(rows).toHaveLength(2);
  });
});

describe('a record cannot be stored incoherent', () => {
  it('refuses a check-out before the check-in', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertRecord(COMPANY_A, {
          id: '00000000-0000-7000-8000-000000009991',
          date: '2026-03-04',
          mode: 'office',
          checkIn: '2026-03-04T09:00:00Z',
          checkOut: '2026-03-04T08:00:00Z',
        }),
      ),
    );
    expect(message).toMatch(/out_after_in/i);
  });

  it('refuses negative derived minutes', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertRecord(COMPANY_A, {
          id: '00000000-0000-7000-8000-000000009992',
          date: '2026-03-05',
          working: '-1',
        }),
      ),
    );
    expect(message).toMatch(/minutes_non_negative/i);
  });

  it('refuses a check-in with no work mode — DOCUMENT 12 rule 2', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertRecord(COMPANY_A, {
          id: '00000000-0000-7000-8000-000000009993',
          date: '2026-03-06',
          checkIn: '2026-03-06T09:00:00Z',
        }),
      ),
    );
    expect(message).toMatch(/mode_with_check_in/i);
  });

  it('refuses a rejected correction with no review note — DOCUMENT 12 validation', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        `INSERT INTO attendance_correction_requests
           (id, company_id, employee_id, date, reason, status, reviewed_by, reviewed_at, updated_at)
         VALUES ('00000000-0000-7000-8000-000000009994', '${COMPANY_A}', '${A.employee}',
           DATE '2026-03-02', 'Forgot', 'rejected', '${A.user}', now(), now())`,
      ),
    );
    expect(message).toMatch(/rejection_has_note/i);
  });

  it('refuses a decided correction that names no reviewer', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        `INSERT INTO attendance_correction_requests
           (id, company_id, employee_id, date, reason, status, updated_at)
         VALUES ('00000000-0000-7000-8000-000000009995', '${COMPANY_A}', '${A.employee}',
           DATE '2026-03-02', 'Forgot', 'approved', now())`,
      ),
    );
    expect(message).toMatch(/review_consistent/i);
  });
});

describe('attendance is never hard-deleted — DOCUMENT 12', () => {
  it('the application role has no DELETE on either table', async () => {
    const message = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM attendance_records'));
    expect(message).toMatch(/permission denied/i);

    const second = await expectRejection(() =>
      asApp(COMPANY_A, 'DELETE FROM attendance_correction_requests'),
    );
    expect(second).toMatch(/permission denied/i);
  });
});

describe('the correction window is a company setting — DOCUMENT 12 rule 13', () => {
  it('defaults to DOCUMENT 12’s seven days', async () => {
    const rows = await asApp<{ correction_window_days: number }>(
      COMPANY_A,
      'SELECT correction_window_days FROM companies',
    );
    expect(rows[0]?.correction_window_days).toBe(7);
  });

  it('accepts a value other than the default', async () => {
    await asApp(COMPANY_A, 'UPDATE companies SET correction_window_days = 30');
    const rows = await asApp<{ correction_window_days: number }>(
      COMPANY_A,
      'SELECT correction_window_days FROM companies',
    );
    expect(rows[0]?.correction_window_days).toBe(30);
  });

  it('refuses a window of zero — that is switching the flow off, not configuring it', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, 'UPDATE companies SET correction_window_days = 0'),
    );
    expect(message).toMatch(/correction_window_days_min/i);
  });

  it('has no maximum — DOCUMENT 12 documents none, so a window beyond a year is accepted', async () => {
    await asApp(COMPANY_A, 'UPDATE companies SET correction_window_days = 366');
    const rows = await asApp<{ correction_window_days: number }>(
      COMPANY_A,
      'SELECT correction_window_days FROM companies',
    );
    expect(rows[0]?.correction_window_days).toBe(366);
  });
});

describe('platform_list_active_company_ids — the nightly run’s enumeration, DOCUMENT 09 §7', () => {
  it('with no tenant bound, the application role sees no companies directly', async () => {
    const rows = await asApp(NO_TENANT, 'SELECT id FROM companies');
    expect(rows).toHaveLength(0);
  });

  it('returns every active company’s id, and nothing but the id, to the application role', async () => {
    const rows = await asApp<Record<string, unknown>>(
      NO_TENANT,
      'SELECT * FROM platform_list_active_company_ids()',
    );
    expect(rows).toEqual([{ id: COMPANY_A }, { id: COMPANY_B }]);
  });

  it('leaves out suspended and soft-deleted companies', async () => {
    await asOwner(COMPANY_A, "UPDATE companies SET status = 'suspended'");
    await asOwner(COMPANY_B, 'UPDATE companies SET deleted_at = now()');
    const rows = await asApp(NO_TENANT, 'SELECT * FROM platform_list_active_company_ids()');
    expect(rows).toHaveLength(0);
  });

  it('is not executable by PUBLIC', async () => {
    const rows = await db.query<{ granted: boolean }>(
      `SELECT has_function_privilege('public', 'platform_list_active_company_ids()', 'EXECUTE') AS granted`,
    );
    expect(rows.rows[0]?.granted).toBe(false);
  });

  it('pins its search_path, so a temporary table cannot shadow companies', async () => {
    const config = await db.query<{ proconfig: string[] }>(
      "SELECT proconfig FROM pg_proc WHERE proname = 'platform_list_active_company_ids'",
    );
    expect(config.rows[0]?.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);

    await db.exec(`SET ROLE ufuq_app; SELECT set_config('app.company_id', '', false);
      CREATE TEMP TABLE companies (id uuid, status text, deleted_at timestamptz);
      INSERT INTO companies VALUES ('00000000-0000-7000-8000-00000000dead', 'active', NULL);`);
    try {
      const rows = await db.query('SELECT * FROM platform_list_active_company_ids()');
      expect(rows.rows).toEqual([{ id: COMPANY_A }, { id: COMPANY_B }]);
    } finally {
      await db.exec('DROP TABLE pg_temp.companies; RESET ROLE;');
    }
  });
});

describe('the designated system actor — DOCUMENT 21 "Record content"', () => {
  const insertSystemUser = (companyId: string, id: string, overrides = ''): string =>
    `INSERT INTO users (id, company_id, email, password_hash, role_id, status, is_system, updated_at)
     VALUES ('${id}', '${companyId}', 'system@ufuq.invalid', NULL, '${ROLE}', 'deactivated', true, now())
     ${overrides}`;

  it('can be created with no password and a deactivated status', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f001'));
    const rows = await asApp<{ is_system: boolean }>(
      COMPANY_A,
      'SELECT is_system FROM users WHERE is_system',
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a second one for the same company', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f002'));
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        `INSERT INTO users (id, company_id, email, password_hash, role_id, status, is_system, updated_at)
         VALUES ('00000000-0000-7000-8000-00000000f003', '${COMPANY_A}', 'other@ufuq.invalid',
                 NULL, '${ROLE}', 'deactivated', true, now())`,
      ),
    );
    expect(message).toMatch(/one_system_actor_per_company|unique/i);
  });

  it('refuses to give it a password — this is what makes "can never authenticate" a fact', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f004'));
    const message = await expectRejection(() =>
      asApp(COMPANY_A, "UPDATE users SET password_hash = 'x' WHERE is_system"),
    );
    expect(message).toMatch(/system_has_no_password/i);
  });

  it('refuses to make it an active or invited account', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f005'));
    const message = await expectRejection(() =>
      asApp(COMPANY_A, "UPDATE users SET status = 'active' WHERE is_system"),
    );
    expect(message).toMatch(/system_is_not_invited/i);
  });

  it('is invisible to the login lookup, so login and password reset cannot reach it', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f006'));
    // `auth_lookup_login` is SECURITY DEFINER and serves both POST /auth/login
    // and POST /auth/forgot-password (DOCUMENT 08 §4.1).
    const rows = await asApp(COMPANY_A, "SELECT * FROM auth_lookup_login('system@ufuq.invalid')");
    expect(rows).toHaveLength(0);
  });

  it('still returns ordinary users from that lookup', async () => {
    const rows = await asApp(COMPANY_A, "SELECT * FROM auth_lookup_login('person@company-a.test')");
    expect(rows).toHaveLength(1);
  });

  it('each company gets its own — one per company, not one globally', async () => {
    await asApp(COMPANY_A, insertSystemUser(COMPANY_A, '00000000-0000-7000-8000-00000000f007'));
    await asApp(COMPANY_B, insertSystemUser(COMPANY_B, '00000000-0000-7000-8000-00000000f008'));
    const a = await asApp(COMPANY_A, 'SELECT id FROM users WHERE is_system');
    const b = await asApp(COMPANY_B, 'SELECT id FROM users WHERE is_system');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
