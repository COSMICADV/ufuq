/**
 * Phase 5 row-level security and reference integrity — AD-03, DOCUMENT 06
 * §3.6, DOCUMENT 07 §9 invariant 7, DOCUMENT 26 §5.
 *
 * Same approach as `phase4-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * The part of this file that is new in kind is the same-company triggers.
 * PostgreSQL checks a foreign key without applying row security, so a
 * reference to another company's row would satisfy the key on its own. The
 * tests below show the trigger refusing it both for the application role and
 * for the owner, who bypasses row-level security entirely.
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
];

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

/** Per-company fixture ids: user, department, position, schedule, employee. */
const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    department: '00000000-0000-7000-8000-0000000001d1',
    position: '00000000-0000-7000-8000-0000000001f1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    department: '00000000-0000-7000-8000-0000000002d2',
    position: '00000000-0000-7000-8000-0000000002f2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
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

function insertEmployee(
  companyId: string,
  overrides: Partial<
    Record<'id' | 'code' | 'email' | 'user' | 'dept' | 'pos' | 'mgr' | 'sched', string>
  >,
): string {
  const own = IDS[companyId as keyof typeof IDS];
  const value = (v: string | undefined): string => (v === undefined ? 'NULL' : `'${v}'`);
  return `INSERT INTO employees (id, company_id, user_id, employee_code, first_name, last_name, email,
            department_id, position_id, manager_id, work_schedule_id, joining_date, updated_at)
          VALUES ('${overrides.id ?? '00000000-0000-7000-8000-00000000ffff'}', '${companyId}',
            ${value(overrides.user)}, '${overrides.code ?? 'EMP-NEW'}', 'First', 'Last',
            ${value(overrides.email)}, ${value(overrides.dept)}, ${value(overrides.pos)},
            ${value(overrides.mgr)}, '${overrides.sched ?? own.schedule}', DATE '2026-01-15', now())`;
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
       INSERT INTO departments (id, company_id, name_ar, name_en, updated_at)
         VALUES ('${own.department}', '${companyId}', 'قسم', 'Dept', now());
       INSERT INTO positions (id, company_id, title_ar, title_en, updated_at)
         VALUES ('${own.position}', '${companyId}', 'مسمى', 'Title', now());
       INSERT INTO work_schedules (id, company_id, name, timezone, half_day_threshold_hours, updated_at)
         VALUES ('${own.schedule}', '${companyId}', 'Schedule', 'Africa/Cairo', 4.00, now());
       ${insertEmployee(companyId, {
         id: own.employee,
         code: 'EMP-001',
         email: `person@${slug}.test`,
         user: own.user,
         dept: own.department,
         pos: own.position,
       })};`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('employees — tenant isolation with no WHERE clause', () => {
  it('SELECT returns only the bound tenant’s employees', async () => {
    const seenByA = await asApp<{ id: string }>(COMPANY_A, 'SELECT id FROM employees');
    const seenByB = await asApp<{ id: string }>(COMPANY_B, 'SELECT id FROM employees');
    expect(seenByA).toEqual([{ id: A.employee }]);
    expect(seenByB).toEqual([{ id: B.employee }]);
  });

  it('a cross-tenant UPDATE rewrites nothing in the other company', async () => {
    await asApp(COMPANY_A, `UPDATE employees SET first_name = 'Renamed'`);
    const [rowB] = await asApp<{ first_name: string }>(
      COMPANY_B,
      'SELECT first_name FROM employees',
    );
    expect(rowB?.first_name).toBe('First');
  });

  it('a cross-tenant DELETE removes nothing in the other company', async () => {
    await asApp(COMPANY_A, 'DELETE FROM employees');
    expect(await asApp(COMPANY_B, 'SELECT id FROM employees')).toHaveLength(1);
  });

  it('an INSERT naming another company is refused by the policy', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertEmployee(COMPANY_B, { code: 'INJECTED' })),
    );
    expect(message).toMatch(/row-level security|same company/i);
  });

  it('with no tenant bound, no employee is visible', async () => {
    expect(await asApp('', 'SELECT id FROM employees')).toHaveLength(0);
  });
});

describe('same-company references — DOCUMENT 07 §9 invariant 7', () => {
  it.each([
    ['manager_id', { mgr: B.employee }],
    ['department_id', { dept: B.department }],
    ['position_id', { pos: B.position }],
    ['work_schedule_id', { sched: B.schedule }],
    ['user_id', { user: B.user }],
  ] as const)('refuses %s pointing at another company, for the app role', async (_field, refs) => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertEmployee(COMPANY_A, { code: 'EMP-X', ...refs })),
    );
    expect(message).toMatch(/same company|row-level security|foreign key/i);
  });

  it('refuses a cross-company manager even for the owner, who bypasses row security', async () => {
    const message = await expectRejection(() =>
      asOwner(COMPANY_A, insertEmployee(COMPANY_A, { code: 'EMP-Y', mgr: B.employee })),
    );
    expect(message).toMatch(/same company/i);
  });

  it('refuses re-pointing an existing employee at another company’s department', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `UPDATE employees SET department_id = '${B.department}' WHERE id = '${A.employee}'`,
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('accepts references that all belong to the same company', async () => {
    await asApp(
      COMPANY_A,
      insertEmployee(COMPANY_A, {
        code: 'EMP-002',
        mgr: A.employee,
        dept: A.department,
        pos: A.position,
      }),
    );
    const rows = await asApp(
      COMPANY_A,
      `SELECT id FROM employees WHERE manager_id = '${A.employee}'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a department manager from another company', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `UPDATE departments SET manager_employee_id = '${B.employee}' WHERE id = '${A.department}'`,
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('accepts a department manager from the same company', async () => {
    await asApp(COMPANY_A, `UPDATE departments SET manager_employee_id = '${A.employee}'`);
    const [row] = await asApp<{ manager_employee_id: string }>(
      COMPANY_A,
      'SELECT manager_employee_id FROM departments',
    );
    expect(row?.manager_employee_id).toBe(A.employee);
  });
});

describe('database-level integrity', () => {
  it('refuses an employee who is their own manager', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE employees SET manager_id = id`),
    );
    expect(message).toMatch(/employees_manager_not_self/);
  });

  it('refuses a duplicate employee code within one company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertEmployee(COMPANY_A, { code: 'EMP-001' })),
    );
    expect(message).toMatch(/employees_company_id_employee_code_key/);
  });

  it('lets two companies use the same employee code', async () => {
    // Both tenants were seeded with EMP-001; the seed succeeding is the proof.
    const forA = await asApp(COMPANY_A, `SELECT id FROM employees WHERE employee_code = 'EMP-001'`);
    const forB = await asApp(COMPANY_B, `SELECT id FROM employees WHERE employee_code = 'EMP-001'`);
    expect([forA.length, forB.length]).toEqual([1, 1]);
  });

  it('refuses a duplicate email within one company', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertEmployee(COMPANY_A, { code: 'EMP-003', email: 'person@company-a.test' }),
      ),
    );
    expect(message).toMatch(/employees_company_id_email_key/);
  });

  it('refuses linking one user to two employees', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertEmployee(COMPANY_A, { code: 'EMP-004', user: A.user })),
    );
    expect(message).toMatch(/employees_user_id_key/);
  });

  it('clears manager_id on reports when a manager row is removed (ON DELETE SET NULL)', async () => {
    const reportId = '00000000-0000-7000-8000-0000000001c1';
    await asApp(
      COMPANY_A,
      insertEmployee(COMPANY_A, { id: reportId, code: 'EMP-005', mgr: A.employee }),
    );
    await asApp(COMPANY_A, `DELETE FROM employees WHERE id = '${A.employee}'`);
    const [row] = await asApp<{ manager_id: string | null }>(
      COMPANY_A,
      `SELECT manager_id FROM employees WHERE id = '${reportId}'`,
    );
    expect(row?.manager_id).toBeNull();
  });

  it('adds exactly the seven DOCUMENT 21 employee audit actions', async () => {
    const result = await db.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::audit_action))::text AS value`,
    );
    const employeeActions = result.rows
      .map((r) => r.value)
      .filter((v) => v.startsWith('employee.'));
    expect(employeeActions.sort()).toEqual(
      [
        'employee.activated',
        'employee.created',
        'employee.deactivated',
        'employee.department_changed',
        'employee.manager_changed',
        'employee.role_changed',
        'employee.updated',
      ].sort(),
    );
  });
});
