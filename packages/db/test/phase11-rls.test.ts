/**
 * Phase 11 row-level security, reference integrity and financial immutability
 * — AD-03, DOCUMENT 06 §3.21–3.26, DOCUMENT 15 rules 1–2, DOCUMENT 26 §5.
 *
 * Same approach as the earlier phase suites: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: immutability the database enforces on its own. A
 * locked payroll line refuses UPDATE and DELETE for the application role *and*
 * for the table owner; a finalized period's figures never change; deductions,
 * bonuses and adjustments are append-only; a salary row's amount is history.
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
    schedule: `00000000-0000-7000-8000-${prefix}e1`,
    employee: `00000000-0000-7000-8000-${prefix}b1`,
    policy: `00000000-0000-7000-8000-${prefix}f1`,
    salary: `00000000-0000-7000-8000-${prefix}c1`,
    period: `00000000-0000-7000-8000-${prefix}d1`,
    line: `00000000-0000-7000-8000-${prefix}d2`,
    deduction: `00000000-0000-7000-8000-${prefix}d3`,
    bonus: `00000000-0000-7000-8000-${prefix}d4`,
    key: `00000000-0000-7000-8000-${prefix}d5`,
  } as const;
}

const IDS = {
  [COMPANY_A]: ids('0000000001'),
  [COMPANY_B]: ids('0000000002'),
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

async function seedCompany(companyId: string, slug: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
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
     INSERT INTO salary_policies (id, company_id, name, daily_wage_basis, fixed_days_value,
          unpaid_leave_deduction, absence_deduction, lateness_rule, overtime_rate, rounding)
       VALUES ('${own.policy}', '${companyId}', 'Policy', 'fixed_days', 30, 'daily_wage',
          'daily_wage', '{"type":"none"}', 0, 'none');
     INSERT INTO employee_salaries (id, company_id, employee_id, monthly_salary, currency,
          effective_from, salary_policy_id, created_by)
       VALUES ('${own.salary}', '${companyId}', '${own.employee}', 20000.00, 'EGP',
          DATE '2026-01-15', '${own.policy}', '${own.user}');
     INSERT INTO payroll_periods (id, company_id, year, month, start_date, end_date,
          generated_by, generated_at, total_gross, total_net)
       VALUES ('${own.period}', '${companyId}', 2026, 3, DATE '2026-03-01', DATE '2026-03-31',
          '${own.user}', now(), 20000.00, 19500.00);
     INSERT INTO payroll_lines (id, payroll_period_id, company_id, employee_id, base_salary,
          daily_wage, working_days, present_days, wfh_days, absent_days, paid_leave_days,
          unpaid_leave_days, late_minutes_total, attendance_adjustment, net_salary, snapshot)
       VALUES ('${own.line}', '${own.period}', '${companyId}', '${own.employee}', 20000.00,
          666.67, 22, 21, 0, 1, 0, 0, 0, -666.67, 19333.33, '{"engine":1}');
     INSERT INTO payroll_deductions (id, payroll_line_id, company_id, type, amount, reason, created_by)
       VALUES ('${own.deduction}', '${own.line}', '${companyId}', 'other', 100.00, 'Laptop damage', '${own.user}');
     INSERT INTO payroll_bonuses (id, payroll_line_id, company_id, type, amount, reason, created_by)
       VALUES ('${own.bonus}', '${own.line}', '${companyId}', 'other', 50.00, 'Great month', '${own.user}');
     INSERT INTO idempotency_keys (id, company_id, user_id, scope, key, request_hash, resource_id)
       VALUES ('${own.key}', '${companyId}', '${own.user}', 'payroll.generate', 'k-1',
          repeat('a', 64), '${own.period}');`,
  );
}

/** Approve, lock every line and finalize — as the application does it. */
async function finalize(companyId: string): Promise<void> {
  const own = IDS[companyId as keyof typeof IDS];
  await asApp(
    companyId,
    `UPDATE payroll_periods SET status = 'approved' WHERE id = '${own.period}'`,
  );
  await asApp(
    companyId,
    `UPDATE payroll_lines SET is_locked = true, snapshot = '{"engine":1,"final":true}'`,
  );
  await asApp(
    companyId,
    `UPDATE payroll_periods SET status = 'finalized', finalized_by = '${own.user}', finalized_at = now()
       WHERE id = '${own.period}'`,
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

  const TABLES = [
    'salary_policies',
    'employee_salaries',
    'payroll_periods',
    'payroll_lines',
    'payroll_deductions',
    'payroll_bonuses',
    'idempotency_keys',
  ] as const;

  describe('tenant isolation', () => {
    for (const table of TABLES) {
      it(`${table}: a bare SELECT sees only the caller company; no tenant sees nothing`, async () => {
        const rows = await asApp<{ company_id: string }>(
          COMPANY_A,
          `SELECT company_id FROM ${table}`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.company_id === COMPANY_A)).toBe(true);
        expect(await asApp('', `SELECT * FROM ${table}`)).toHaveLength(0);
      });
    }

    it('an UPDATE with no WHERE cannot reach another company’s period', async () => {
      await asApp(COMPANY_A, `UPDATE payroll_periods SET total_net = 1`);
      const other = await asApp<{ total_net: string }>(
        COMPANY_B,
        'SELECT total_net FROM payroll_periods',
      );
      expect(other[0]?.total_net).toBe('19500.00');
    });

    it('a line cannot point at another company’s employee or period', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO payroll_lines (id, payroll_period_id, company_id, employee_id, base_salary,
             daily_wage, working_days, present_days, wfh_days, absent_days, paid_leave_days,
             unpaid_leave_days, late_minutes_total, attendance_adjustment, net_salary, snapshot)
           VALUES ('00000000-0000-7000-8000-0000000009f1', '${A.period}', '${COMPANY_A}',
             '${B.employee}', 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, '{}')`,
        ),
      );
      expect(message).toMatch(/same company/);
    });
  });

  describe('least privilege: nothing financial is deleted, entries are append-only', () => {
    for (const table of [
      'salary_policies',
      'employee_salaries',
      'payroll_periods',
      'payroll_deductions',
      'payroll_bonuses',
      'payroll_adjustments',
      'idempotency_keys',
    ]) {
      it(`${table}: the application role cannot DELETE`, async () => {
        const message = await expectRejection(() => asApp(COMPANY_A, `DELETE FROM ${table}`));
        expect(message).toMatch(/permission denied/i);
      });
    }

    for (const table of ['payroll_deductions', 'payroll_bonuses', 'payroll_adjustments']) {
      it(`${table}: the application role cannot UPDATE`, async () => {
        const message = await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE ${table} SET reason = 'rewritten'`),
        );
        expect(message).toMatch(/permission denied/i);
      });
    }

    it('a deduction needs a positive amount and a reason of at least 3 characters', async () => {
      const add = (amount: string, reason: string) =>
        asApp(
          COMPANY_A,
          `INSERT INTO payroll_deductions (id, payroll_line_id, company_id, type, amount, reason, created_by)
             VALUES ('00000000-0000-7000-8000-00000000aa01', '${A.line}', '${COMPANY_A}', 'other',
               ${amount}, '${reason}', '${A.user}')`,
        );
      expect(await expectRejection(() => add('0', 'Valid reason'))).toMatch(/amount_positive/);
      expect(await expectRejection(() => add('10', 'ab'))).toMatch(/reason_length/);
    });
  });

  describe('salary history (DOCUMENT 06 §3.21)', () => {
    it('an amount or start date is never rewritten; an open row is closed once', async () => {
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE employee_salaries SET monthly_salary = 1`),
        ),
      ).toMatch(/only effective_to may be set/);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE employee_salaries SET effective_from = DATE '2026-01-01'`),
        ),
      ).toMatch(/only effective_to may be set/);
      await asApp(COMPANY_A, `UPDATE employee_salaries SET effective_to = DATE '2026-03-14'`);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE employee_salaries SET effective_to = DATE '2026-03-20'`),
        ),
      ).toMatch(/already closed/);
      // The owner is held to the same history rule.
      expect(
        await expectRejection(() =>
          asOwner(COMPANY_A, `UPDATE employee_salaries SET monthly_salary = 1`),
        ),
      ).toMatch(/only effective_to may be set/);
    });

    it('two rows of one employee never overlap', async () => {
      const insert = (from: string) =>
        asApp(
          COMPANY_A,
          `INSERT INTO employee_salaries (id, company_id, employee_id, monthly_salary, currency,
             effective_from, salary_policy_id, created_by)
           VALUES ('00000000-0000-7000-8000-00000000ab01', '${COMPANY_A}', '${A.employee}', 25000,
             'EGP', DATE '${from}', '${A.policy}', '${A.user}')`,
        );
      expect(await expectRejection(() => insert('2026-03-15'))).toMatch(/may not overlap/);
      await asApp(COMPANY_A, `UPDATE employee_salaries SET effective_to = DATE '2026-03-14'`);
      await insert('2026-03-15');
      const rows = await asApp<{ monthly_salary: string; effective_to: string | null }>(
        COMPANY_A,
        'SELECT monthly_salary, effective_to::text FROM employee_salaries ORDER BY effective_from',
      );
      expect(rows).toEqual([
        { monthly_salary: '20000.00', effective_to: '2026-03-14' },
        { monthly_salary: '25000.00', effective_to: null },
      ]);
    });
  });

  describe('salary policy configuration (DOCUMENT 06 §3.22)', () => {
    it('the fixed divisor exists exactly for fixed_days, and the lateness rule is a known one', async () => {
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE salary_policies SET fixed_days_value = NULL`),
        ),
      ).toMatch(/fixed_days_matches_basis/);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE salary_policies SET lateness_rule = '{"type":"tiered"}'`),
        ),
      ).toMatch(/lateness_rule_known/);
      await asApp(
        COMPANY_A,
        `UPDATE salary_policies SET daily_wage_basis = 'calendar_days', fixed_days_value = NULL`,
      );
    });

    it('one default policy per company', async () => {
      const message = await expectRejection(() =>
        asApp(
          COMPANY_A,
          `INSERT INTO salary_policies (id, company_id, name, daily_wage_basis, unpaid_leave_deduction,
             absence_deduction, lateness_rule, overtime_rate, rounding)
           VALUES ('00000000-0000-7000-8000-00000000ac01', '${COMPANY_A}', 'Second', 'calendar_days',
             'none', 'none', '{"type":"none"}', 0, 'none')`,
        ),
      );
      expect(message).toMatch(/one_default_per_company|duplicate key/);
    });
  });

  describe('payroll lines follow their period, and a locked line is frozen', () => {
    it('net salary can never be negative (OD-06)', async () => {
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE payroll_lines SET net_salary = -1`)),
      ).toMatch(/net_non_negative/);
    });

    it('a draft line is editable; an approved period’s unlocked line is not', async () => {
      await asApp(COMPANY_A, `UPDATE payroll_lines SET net_salary = 19000`);
      await asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'approved'`);
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE payroll_lines SET net_salary = 1`)),
      ).toMatch(/not editable while its period is approved/);
    });

    it('locking is only by finalizing an approved period, and changes no figure', async () => {
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE payroll_lines SET is_locked = true`)),
      ).toMatch(/only be locked unchanged/);
      await asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'approved'`);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE payroll_lines SET is_locked = true, net_salary = 1`),
        ),
      ).toMatch(/only be locked unchanged/);
    });

    it('a period cannot be finalized while a line is unlocked', async () => {
      await asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'approved'`);
      expect(
        await expectRejection(() =>
          asApp(
            COMPANY_A,
            `UPDATE payroll_periods SET status = 'finalized', finalized_by = '${A.user}', finalized_at = now()`,
          ),
        ),
      ).toMatch(/unlocked lines/);
    });

    it('UPDATE of a locked line fails — for the application role and for the owner', async () => {
      await finalize(COMPANY_A);
      for (const run of [asApp, asOwner] as const) {
        const message = await expectRejection(() =>
          run(COMPANY_A, `UPDATE payroll_lines SET net_salary = 1`),
        );
        expect(message).toMatch(/locked: finalized payroll is immutable/);
        expect(
          await expectRejection(() => run(COMPANY_A, `UPDATE payroll_lines SET is_locked = false`)),
        ).toMatch(/locked: finalized payroll is immutable/);
      }
      const rows = await asApp<{ net_salary: string; is_locked: boolean }>(
        COMPANY_A,
        'SELECT net_salary, is_locked FROM payroll_lines',
      );
      expect(rows).toEqual([{ net_salary: '19333.33', is_locked: true }]);
    });

    it('DELETE of a locked line fails — for the application role and for the owner', async () => {
      await finalize(COMPANY_A);
      for (const run of [asApp, asOwner] as const) {
        expect(await expectRejection(() => run(COMPANY_A, `DELETE FROM payroll_lines`))).toMatch(
          /locked: finalized payroll is immutable|violates foreign key/,
        );
      }
      // Without its entries in the way, the lock alone still refuses it.
      const bare = '00000000-0000-7000-8000-0000000009e1';
      expect(
        await expectRejection(() =>
          asOwner(COMPANY_A, `DELETE FROM payroll_lines WHERE id = '${bare}' OR is_locked`),
        ),
      ).toMatch(/locked: finalized payroll is immutable|violates foreign key/);
      expect(await asApp(COMPANY_A, 'SELECT id FROM payroll_lines')).toHaveLength(1);
    });

    it('no database function writes to payroll_lines', async () => {
      const rows = await db.query<{ proname: string }>(
        `SELECT proname FROM pg_proc
          WHERE prosrc ~* '(update|delete\\s+from|insert\\s+into)\\s+"?payroll_lines'`,
      );
      expect(rows.rows).toEqual([]);
    });
  });

  describe('a finalized period is immutable and only moves forward', () => {
    it('its figures never change; it goes finalized → paid → adjusted, never back', async () => {
      await finalize(COMPANY_A);
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE payroll_periods SET total_net = 1`)),
      ).toMatch(/figures are immutable/);
      expect(
        await expectRejection(() =>
          asOwner(COMPANY_A, `UPDATE payroll_periods SET total_gross = 1`),
        ),
      ).toMatch(/figures are immutable/);
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'draft'`),
        ),
      ).toMatch(/cannot move from finalized to draft/);
      await asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'paid', paid_at = now()`);
      await asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'adjusted'`);
      expect(
        await expectRejection(() => asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'paid'`)),
      ).toMatch(/cannot move from adjusted to paid/);
      expect(
        await expectRejection(() => asOwner(COMPANY_A, `DELETE FROM payroll_periods`)),
      ).toMatch(/never deleted|violates foreign key/);
    });

    it('paid and adjusted need a finalized period first', async () => {
      expect(
        await expectRejection(() =>
          asApp(COMPANY_A, `UPDATE payroll_periods SET status = 'paid', paid_at = now()`),
        ),
      ).toMatch(/finalized first|finalized_fields/);
    });

    it('deductions and bonuses only on an editable line; adjustments only on a locked one', async () => {
      const deduction = () =>
        asApp(
          COMPANY_A,
          `INSERT INTO payroll_deductions (id, payroll_line_id, company_id, type, amount, reason, created_by)
             VALUES ('00000000-0000-7000-8000-00000000ad01', '${A.line}', '${COMPANY_A}', 'other',
               10, 'Late return', '${A.user}')`,
        );
      const adjustment = (id: string) =>
        asApp(
          COMPANY_A,
          `INSERT INTO payroll_adjustments (id, original_payroll_line_id, company_id, employee_id,
             amount, reason, created_by)
           VALUES ('${id}', '${A.line}', '${COMPANY_A}', '${A.employee}', -150.25, 'Overpaid', '${A.user}')`,
        );
      expect(
        await expectRejection(() => adjustment('00000000-0000-7000-8000-00000000ae01')),
      ).toMatch(/needs a finalized line/);
      await finalize(COMPANY_A);
      expect(await expectRejection(deduction)).toMatch(/not editable/);
      await adjustment('00000000-0000-7000-8000-00000000ae02');
      const rows = await asApp<{ amount: string }>(
        COMPANY_A,
        'SELECT amount FROM payroll_adjustments',
      );
      expect(rows).toEqual([{ amount: '-150.25' }]);
      // The original line is untouched by the adjustment.
      const line = await asApp<{ net_salary: string }>(
        COMPANY_A,
        'SELECT net_salary FROM payroll_lines',
      );
      expect(line).toEqual([{ net_salary: '19333.33' }]);
    });

    it('one period per company per month', async () => {
      const message = await expectRejection(() =>
        asApp(
          COMPANY_A,
          `INSERT INTO payroll_periods (id, company_id, year, month, start_date, end_date,
             generated_by, generated_at)
           VALUES ('00000000-0000-7000-8000-00000000af01', '${COMPANY_A}', 2026, 3,
             DATE '2026-03-01', DATE '2026-03-31', '${A.user}', now())`,
        ),
      );
      expect(message).toMatch(/duplicate key|company_id_year_month_key/);
    });
  });
});
