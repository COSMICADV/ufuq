/**
 * Phase 10 row-level security, reference integrity and table guarantees —
 * AD-03, DOCUMENT 06 §3.10–3.14, DOCUMENT 07 §9 invariant 7, DOCUMENT 16,
 * OD-09, OD-11, DOCUMENT 26 §5.
 *
 * Same approach as `phase9-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: leave types the database seeds for every company, a
 * leave record that writes its own Requests Centre row, the Phase 9 leave
 * refusal replaced by the real linkage rule, and a narrow function that may
 * remove only a future day written by leave.
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

const PHASE10 = '20261010000000_phase10_leave';

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
    colleague: '00000000-0000-7000-8000-0000000001b2',
    colleagueUser: '00000000-0000-7000-8000-0000000001a2',
    leave: '00000000-0000-7000-8000-0000000001c1',
    balance: '00000000-0000-7000-8000-0000000001d1',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    colleague: '00000000-0000-7000-8000-0000000002b3',
    colleagueUser: '00000000-0000-7000-8000-0000000002a3',
    leave: '00000000-0000-7000-8000-0000000002c2',
    balance: '00000000-0000-7000-8000-0000000002d2',
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

async function typeId(companyId: string, nameEn: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM leave_types WHERE company_id = '${companyId}' AND name_en = '${nameEn}'`,
  );
  return rows.rows[0]?.id as string;
}

interface LeaveOverrides {
  readonly id?: string;
  readonly employee?: string;
  readonly type?: string;
  readonly days?: string;
  readonly reason?: string;
  readonly status?: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly reviewedBy?: string | null;
  readonly reviewedAt?: string | null;
  readonly note?: string | null;
}

function insertLeave(companyId: string, type: string, o: LeaveOverrides = {}): string {
  const own = IDS[companyId as keyof typeof IDS];
  const reviewedBy =
    o.reviewedBy === undefined || o.reviewedBy === null ? 'NULL' : `'${o.reviewedBy}'`;
  const reviewedAt =
    o.reviewedAt === undefined || o.reviewedAt === null ? 'NULL' : `TIMESTAMPTZ '${o.reviewedAt}'`;
  const note = o.note === undefined || o.note === null ? 'NULL' : `'${o.note}'`;
  return `INSERT INTO leave_requests
            (id, company_id, employee_id, leave_type_id, start_date, end_date, days_count,
             year_allocation, reason, status, reviewed_by, reviewed_at, review_note)
          VALUES ('${o.id ?? own.leave}', '${companyId}', '${o.employee ?? own.employee}',
            '${o.type ?? type}', DATE '2026-03-15', DATE '2026-03-17', ${o.days ?? '3'},
            '{"2026": "3.00"}'::jsonb, '${o.reason ?? 'Family trip'}', '${o.status ?? 'pending'}',
            ${reviewedBy}, ${reviewedAt}, ${note})`;
}

async function seedCompany(companyId: string, slug: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
  await asOwner(
    companyId,
    `INSERT INTO companies (id, name, slug, timezone, updated_at)
       VALUES ('${companyId}', '${slug}', '${slug}', 'Africa/Cairo', now());
     INSERT INTO users (id, company_id, email, role_id, updated_at)
       VALUES ('${own.user}', '${companyId}', 'person@${slug}.test', '${ROLE}', now()),
              ('${own.colleagueUser}', '${companyId}', 'colleague@${slug}.test', '${ROLE}', now());
     INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
       VALUES ('${own.schedule}', '${companyId}', 'Schedule', 'Africa/Cairo', 4.00, now());
     INSERT INTO employees (id, company_id, user_id, employee_code, first_name, last_name,
          work_schedule_id, joining_date, updated_at)
       VALUES ('${own.employee}', '${companyId}', '${own.user}', 'EMP-001', 'First', 'Last',
          '${own.schedule}', DATE '2026-01-15', now()),
              ('${own.colleague}', '${companyId}', '${own.colleagueUser}', 'EMP-002', 'Second',
          'Person', '${own.schedule}', DATE '2026-01-15', now());`,
  );
}

async function seedRole(): Promise<void> {
  await db.exec(
    `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
     VALUES ('${ROLE}', NULL, 'employee', 'Employee', 'موظف', true, now());`,
  );
}

describe('with every migration applied', () => {
  beforeEach(async () => {
    db = new PGlite();
    for (const name of MIGRATION_NAMES) await db.exec(migrationSql(name));
    await seedRole();
    for (const [companyId, slug] of [
      [COMPANY_A, 'company-a'],
      [COMPANY_B, 'company-b'],
    ] as const) {
      await seedCompany(companyId, slug);
      const own = IDS[companyId];
      const annual = await typeId(companyId, 'Annual');
      await asOwner(
        companyId,
        `INSERT INTO leave_balances (id, company_id, employee_id, leave_type_id, year, total_days)
           VALUES ('${own.balance}', '${companyId}', '${own.employee}', '${annual}', 2026, 14);
         ${insertLeave(companyId, annual)};`,
      );
    }
  });

  afterEach(async () => {
    await db.close();
  });

  describe('seeded leave types (DOCUMENT 16)', () => {
    it('every new company receives the five starting types, configurable and at zero', async () => {
      const rows = await asApp<{
        name_en: string;
        name_ar: string;
        is_paid: boolean;
        requires_attachment: boolean;
        default_days_per_year: string;
      }>(COMPANY_A, 'SELECT * FROM leave_types ORDER BY name_en');
      expect(rows.map((row) => row.name_en)).toEqual([
        'Annual',
        'Emergency',
        'Other',
        'Sick',
        'Unpaid',
      ]);
      expect(rows.every((row) => Number(row.default_days_per_year) === 0)).toBe(true);
      expect(rows.every((row) => row.name_ar.length > 0)).toBe(true);
      expect(rows.find((row) => row.name_en === 'Unpaid')?.is_paid).toBe(false);
      expect(rows.find((row) => row.name_en === 'Sick')?.requires_attachment).toBe(true);
    });

    it('a cap exists exactly when the policy is capped', async () => {
      const annual = await typeId(COMPANY_A, 'Annual');
      const noCap = await expectRejection(() =>
        asApp(
          COMPANY_A,
          `UPDATE leave_types SET carry_over_policy = 'capped' WHERE id = '${annual}'`,
        ),
      );
      expect(noCap).toMatch(/leave_types_cap_matches_policy/);
      await asApp(
        COMPANY_A,
        `UPDATE leave_types SET carry_over_policy = 'capped', carry_over_cap = 5 WHERE id = '${annual}'`,
      );
    });
  });

  describe('tenant isolation on the three tables', () => {
    for (const table of ['leave_types', 'leave_balances', 'leave_requests']) {
      it(`${table}: a bare SELECT sees only the caller company; no tenant sees nothing`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.company_id === COMPANY_A)).toBe(true);
        expect(await asApp('', `SELECT * FROM ${table}`)).toHaveLength(0);
      });

      it(`${table}: the application role cannot delete`, async () => {
        const message = await expectRejection(() => asApp(COMPANY_A, `DELETE FROM ${table}`));
        expect(message).toMatch(/permission denied/i);
      });
    }

    it('an UPDATE with no WHERE cannot reach another company’s balance', async () => {
      await asApp(COMPANY_A, 'UPDATE leave_balances SET total_days = 99');
      const other = await asApp<{ total_days: string }>(
        COMPANY_B,
        'SELECT total_days FROM leave_balances',
      );
      expect(Number(other[0]?.total_days)).toBe(14);
    });

    it('naming another company’s leave request by primary key finds nothing', async () => {
      expect(
        await asApp(COMPANY_A, `SELECT * FROM leave_requests WHERE id = '${B.leave}'`),
      ).toHaveLength(0);
    });
  });

  describe('same-company references', () => {
    it('a balance or request cannot use another company’s leave type', async () => {
      const foreign = await typeId(COMPANY_B, 'Annual');
      const balance = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO leave_balances (id, company_id, employee_id, leave_type_id, year)
             VALUES ('00000000-0000-7000-8000-00000000aaa1', '${COMPANY_A}', '${A.employee}', '${foreign}', 2027)`,
        ),
      );
      expect(balance).toMatch(/same company/);
      const request = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertLeave(COMPANY_A, foreign, { id: '00000000-0000-7000-8000-00000000aaa2' }),
        ),
      );
      expect(request).toMatch(/same company/);
    });

    it('a leave attendance day must belong to that leave’s employee', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO attendance_records (id, company_id, employee_id, date, status, source, leave_request_id, updated_at)
             VALUES ('00000000-0000-7000-8000-00000000aaa3', '${COMPANY_A}', '${A.colleague}',
               DATE '2026-03-15', 'on_leave', 'system', '${A.leave}', now())`,
        ),
      );
      expect(message).toMatch(/same company/);
    });

    it('a day linked to leave must be on_leave', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO attendance_records (id, company_id, employee_id, date, status, source, leave_request_id, updated_at)
             VALUES ('00000000-0000-7000-8000-00000000aaa4', '${COMPANY_A}', '${A.employee}',
               DATE '2026-03-15', 'present', 'system', '${A.leave}', now())`,
        ),
      );
      expect(message).toMatch(/attendance_records_leave_is_on_leave/);
    });
  });

  describe('leave request shape (DOCUMENT 16 validation, OD-11)', () => {
    it('full days only, a positive count, a 3-character reason', async () => {
      const annual = await typeId(COMPANY_A, 'Annual');
      for (const [o, constraint] of [
        [{ days: '1.5' }, 'leave_requests_days_positive_whole'],
        [{ days: '0' }, 'leave_requests_days_positive_whole'],
        [{ reason: 'no' }, 'leave_requests_reason_length'],
      ] as const) {
        const message = await expectRejection(() =>
          asOwner(
            COMPANY_A,
            insertLeave(COMPANY_A, annual, { id: '00000000-0000-7000-8000-00000000aab1', ...o }),
          ),
        );
        expect(message).toMatch(new RegExp(constraint));
      }
    });

    it('a rejection carries a note; a decision names its reviewer', async () => {
      const annual = await typeId(COMPANY_A, 'Annual');
      const base = { id: '00000000-0000-7000-8000-00000000aab2' };
      const noNote = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertLeave(COMPANY_A, annual, {
            ...base,
            status: 'rejected',
            reviewedBy: A.colleagueUser,
            reviewedAt: '2026-03-10T08:00:00Z',
          }),
        ),
      );
      expect(noNote).toMatch(/leave_requests_rejection_has_note/);
      const noReviewer = await expectRejection(() =>
        asOwner(COMPANY_A, insertLeave(COMPANY_A, annual, { ...base, status: 'approved' })),
      );
      expect(noReviewer).toMatch(/leave_requests_review_consistent/);
    });

    it('a balance can never go below zero in any column', async () => {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, `UPDATE leave_balances SET pending_days = -1 WHERE id = '${A.balance}'`),
      );
      expect(message).toMatch(/leave_balances_non_negative/);
    });
  });

  describe('the Requests Centre index (OD-09, completed for leave)', () => {
    it('a leave request writes its inbox row, which follows every decision', async () => {
      const rows = await asApp<{ category: string; related_id: string; status: string }>(
        COMPANY_A,
        `SELECT category, related_id, status FROM requests WHERE related_type = 'leave_request'`,
      );
      expect(rows).toEqual([{ category: 'leave', related_id: A.leave, status: 'pending' }]);

      await asApp(
        COMPANY_A,
        `UPDATE leave_requests SET status = 'approved', reviewed_by = '${A.colleagueUser}',
           reviewed_at = TIMESTAMPTZ '2026-03-10T08:00:00Z', review_note = 'Enjoy'
         WHERE id = '${A.leave}'`,
      );
      const approved = await asApp<{
        status: string;
        admin_response: string;
        reviewed_at: Date | null;
      }>(
        COMPANY_A,
        `SELECT status, admin_response, reviewed_at FROM requests WHERE related_id = '${A.leave}'`,
      );
      expect(approved[0]).toMatchObject({ status: 'approved', admin_response: 'Enjoy' });
      expect(approved[0]?.reviewed_at).not.toBeNull();

      // An ADMIN cancelling approved leave: the leave keeps its decision; the
      // inbox row is cancelled with no review time (its own CHECK).
      await asApp(
        COMPANY_A,
        `UPDATE leave_requests SET status = 'cancelled' WHERE id = '${A.leave}'`,
      );
      const cancelled = await asApp<{ status: string; reviewed_at: Date | null }>(
        COMPANY_A,
        `SELECT status, reviewed_at FROM requests WHERE related_id = '${A.leave}'`,
      );
      expect(cancelled[0]).toEqual({ status: 'cancelled', reviewed_at: null });
    });

    it('a leave inbox row must point at this employee’s own leave request', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO requests (id, company_id, employee_id, category, related_type, related_id, status)
             VALUES ('00000000-0000-7000-8000-00000000aac1', '${COMPANY_A}', '${A.colleague}', 'leave',
               'leave_request', '${A.leave}', 'pending')`,
        ),
      );
      expect(message).toMatch(/same company|duplicate key/);
      const nowhere = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO requests (id, company_id, employee_id, category, related_type, related_id, status)
             VALUES ('00000000-0000-7000-8000-00000000aac2', '${COMPANY_A}', '${A.employee}', 'leave',
               'leave_request', '00000000-0000-7000-8000-00000000eeee', 'pending')`,
        ),
      );
      expect(nowhere).toMatch(/same company/);
    });
  });

  describe('removing a future leave day (DOCUMENT 16 rule 15 vs DOCUMENT 12)', () => {
    async function leaveDay(id: string, date: string, extra = ''): Promise<void> {
      await asOwner(
        COMPANY_A,
        `INSERT INTO attendance_records (id, company_id, employee_id, date, status, source, leave_request_id, updated_at${extra === '' ? '' : ', check_in_at'})
           VALUES ('${id}', '${COMPANY_A}', '${A.employee}', DATE '${date}', 'on_leave', 'system', '${A.leave}', now()${extra})`,
      );
    }

    it('removes only that leave’s own, never-worked, not-yet-happened day', async () => {
      await leaveDay('00000000-0000-7000-8000-00000000ad01', '2026-03-16');
      await leaveDay('00000000-0000-7000-8000-00000000ad02', '2026-03-09');
      // A future day is removable.
      await asApp(
        COMPANY_A,
        `SELECT attendance_remove_future_leave_day('00000000-0000-7000-8000-00000000ad01', '${A.leave}', DATE '2026-03-10')`,
      );
      // A past day is history: refused.
      const past = await expectRejection(() =>
        asApp(
          COMPANY_A,
          `SELECT attendance_remove_future_leave_day('00000000-0000-7000-8000-00000000ad02', '${A.leave}', DATE '2026-03-10')`,
        ),
      );
      expect(past).toMatch(/not a future day/);
      // Another company cannot remove it either.
      const foreign = await expectRejection(() =>
        asApp(
          COMPANY_B,
          `SELECT attendance_remove_future_leave_day('00000000-0000-7000-8000-00000000ad02', '${A.leave}', DATE '2026-01-01')`,
        ),
      );
      expect(foreign).toMatch(/not a future day/);
      const left = await asApp<{ id: string }>(COMPANY_A, 'SELECT id FROM attendance_records');
      expect(left.map((row) => row.id)).toEqual(['00000000-0000-7000-8000-00000000ad02']);
    });
  });

  it('attachments accept a leave request as their record', async () => {
    await asOwner(
      COMPANY_A,
      `INSERT INTO attachments
         (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes,
          checksum, related_type, related_id)
       VALUES ('00000000-0000-7000-8000-00000000bbb1', '${COMPANY_A}', '${A.user}', 'note.pdf',
         '${COMPANY_A}/bbb1', 'application/pdf', 10, '${'a'.repeat(64)}', 'leave_request', '${A.leave}')`,
    );
  });

  it('has DOCUMENT 16’s indexes and unique balance key', async () => {
    const result = await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename IN ('leave_requests', 'leave_balances')",
    );
    const names = result.rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'leave_requests_company_id_status_idx',
        'leave_requests_employee_id_start_date_idx',
        'leave_balances_employee_id_leave_type_id_year_key',
      ]),
    );
    const annual = await typeId(COMPANY_A, 'Annual');
    const duplicate = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `INSERT INTO leave_balances (id, company_id, employee_id, leave_type_id, year)
           VALUES ('00000000-0000-7000-8000-00000000aad1', '${COMPANY_A}', '${A.employee}', '${annual}', 2026)`,
      ),
    );
    expect(duplicate).toMatch(/duplicate key/);
  });
});

describe('the backfill — companies that predate Phase 10', () => {
  afterEach(async () => {
    await db.close();
  });

  it('an existing company receives the five starting types', async () => {
    db = new PGlite();
    for (const name of MIGRATION_NAMES.filter((n) => n < PHASE10))
      await db.exec(migrationSql(name));
    await seedRole();
    await seedCompany(COMPANY_A, 'company-a');
    for (const name of MIGRATION_NAMES.filter((n) => n >= PHASE10))
      await db.exec(migrationSql(name));
    const rows = await asApp<{ name_en: string; id: string }>(
      COMPANY_A,
      'SELECT name_en, id FROM leave_types',
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]?.id[14]).toBe('7');
  });
});
