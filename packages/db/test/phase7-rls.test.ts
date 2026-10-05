/**
 * Phase 7 row-level security, reference integrity and table guarantees —
 * AD-03, DOCUMENT 06 §3.15–3.17, DOCUMENT 07 §9 invariant 7, DOCUMENT 13,
 * DOCUMENT 26 §5.
 *
 * Same approach as `phase6-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: two child tables whose policy walks the parent task
 * rather than reading a tenant column of their own, a soft-delete-only table,
 * and an append-only one.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

/** Every migration, in application order — the schema a deployment has. */
const MIGRATIONS = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) =>
    readFileSync(
      fileURLToPath(new URL(`${name}/migration.sql`, `file://${MIGRATIONS_DIRECTORY}`)),
      'utf8',
    ),
  );

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
    department: '00000000-0000-7000-8000-0000000001d1',
    task: '00000000-0000-7000-8000-0000000001c1',
    item: '00000000-0000-7000-8000-0000000001f1',
    update: '00000000-0000-7000-8000-000000000171',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    department: '00000000-0000-7000-8000-0000000002d2',
    task: '00000000-0000-7000-8000-0000000002c2',
    item: '00000000-0000-7000-8000-0000000002f2',
    update: '00000000-0000-7000-8000-000000000272',
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

interface TaskOverrides {
  readonly id?: string;
  readonly assignee?: string;
  readonly department?: string | null;
  readonly createdBy?: string;
  readonly title?: string;
  readonly status?: string;
  readonly completedAt?: string | null;
  readonly cancelledReason?: string | null;
  readonly startDate?: string | null;
  readonly deadline?: string | null;
  readonly progress?: string;
}

function insertTask(companyId: string, overrides: TaskOverrides = {}): string {
  const own = IDS[companyId as keyof typeof IDS];
  const text = (v: string | null | undefined): string =>
    v === null || v === undefined ? 'NULL' : `'${v}'`;
  return `INSERT INTO tasks
            (id, company_id, title, assignee_employee_id, department_id, priority, status,
             start_date, deadline, completed_at, progress_percent, created_by, cancelled_reason,
             updated_at)
          VALUES ('${overrides.id ?? '00000000-0000-7000-8000-00000000ffff'}', '${companyId}',
            '${overrides.title ?? 'Prepare the report'}', '${overrides.assignee ?? own.employee}',
            ${overrides.department === undefined ? `'${own.department}'` : text(overrides.department)},
            'medium', '${overrides.status ?? 'not_started'}',
            ${overrides.startDate ? `DATE '${overrides.startDate}'` : 'NULL'},
            ${overrides.deadline ? `DATE '${overrides.deadline}'` : 'NULL'},
            ${overrides.completedAt ? `TIMESTAMPTZ '${overrides.completedAt}'` : 'NULL'},
            ${overrides.progress ?? '0'}, '${overrides.createdBy ?? own.user}',
            ${text(overrides.cancelledReason)}, now())`;
}

function insertItem(
  taskId: string,
  id: string,
  overrides: { title?: string; completed?: boolean; completedBy?: string; position?: number } = {},
): string {
  const completed = overrides.completed ?? false;
  return `INSERT INTO task_checklist_items
            (id, task_id, title, is_completed, completed_at, completed_by, position, updated_at)
          VALUES ('${id}', '${taskId}', '${overrides.title ?? 'Draft'}', ${completed},
            ${completed ? 'now()' : 'NULL'},
            ${overrides.completedBy ? `'${overrides.completedBy}'` : 'NULL'},
            ${overrides.position ?? 0}, now())`;
}

function insertUpdate(
  taskId: string,
  id: string,
  createdBy: string,
  overrides: { employee?: string | null; note?: string } = {},
): string {
  const employee = overrides.employee === null ? 'NULL' : `'${overrides.employee ?? A.employee}'`;
  return `INSERT INTO task_progress_updates
            (id, task_id, employee_id, note, progress_percent_at_time, created_by)
          VALUES ('${id}', '${taskId}', ${employee}, '${overrides.note ?? 'Started'}', 25, '${createdBy}')`;
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
       INSERT INTO departments (id, company_id, name_ar, name_en, updated_at)
         VALUES ('${own.department}', '${companyId}', 'قسم', 'Department', now());
       INSERT INTO employees (id, company_id, user_id, employee_code, first_name, last_name,
            work_schedule_id, joining_date, updated_at)
         VALUES ('${own.employee}', '${companyId}', '${own.user}', 'EMP-001', 'First', 'Last',
            '${own.schedule}', DATE '2026-01-15', now());
       ${insertTask(companyId, { id: own.task })};
       ${insertItem(own.task, own.item)};
       ${insertUpdate(own.task, own.update, own.user, { employee: own.employee })};`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('tasks — tenant isolation', () => {
  it('a bare SELECT returns only the caller company’s rows', async () => {
    const rows = await asApp<{ company_id: string }>(COMPANY_A, 'SELECT * FROM tasks');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(COMPANY_A);
  });

  it('naming another company’s task by primary key still finds nothing', async () => {
    const rows = await asApp(COMPANY_A, `SELECT * FROM tasks WHERE id = '${B.task}'`);
    expect(rows).toHaveLength(0);
  });

  it('with no tenant bound, the role sees no tasks at all', async () => {
    const rows = await asApp('', 'SELECT * FROM tasks');
    expect(rows).toHaveLength(0);
  });

  it('refuses to insert a task for another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertTask(COMPANY_B, { id: '00000000-0000-7000-8000-00000000aaaa' })),
    );
    // As in Phase 6: the same-company trigger fires first and its own lookup
    // is row-secured, so it is the one that refuses. Both guards would.
    expect(message).toMatch(/row-level security|policy|same company/i);
  });

  it('an UPDATE with no WHERE cannot reach another company’s task', async () => {
    await asApp(COMPANY_A, "UPDATE tasks SET title = 'Touched by A'");
    const other = await asApp<{ title: string }>(COMPANY_B, 'SELECT title FROM tasks');
    expect(other[0]?.title).toBe('Prepare the report');
  });

  it('cannot move a task into another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE tasks SET company_id = '${COMPANY_B}'`),
    );
    expect(message).toMatch(/row-level security|policy|same company/i);
  });
});

describe('tasks — same-company references', () => {
  it('refuses another company’s employee as assignee', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertTask(COMPANY_A, { id: '00000000-0000-7000-8000-00000000aab1', assignee: B.employee }),
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('refuses another company’s department', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertTask(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000aab2',
          department: B.department,
        }),
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('refuses another company’s user as creator', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertTask(COMPANY_A, { id: '00000000-0000-7000-8000-00000000aab3', createdBy: B.user }),
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('refuses reassigning an existing task to another company’s employee', async () => {
    const message = await expectRejection(() =>
      asOwner(COMPANY_A, `UPDATE tasks SET assignee_employee_id = '${B.employee}'`),
    );
    expect(message).toMatch(/same company/);
  });
});

describe('tasks — table guarantees (DOCUMENT 13)', () => {
  const NEW = '00000000-0000-7000-8000-00000000bbb1';

  it('refuses a title shorter than three characters, even padded with spaces', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertTask(COMPANY_A, { id: NEW, title: '  ab  ' })),
    );
    expect(message).toMatch(/tasks_title_length/);
  });

  it('refuses a deadline before the start date, and accepts the same day', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertTask(COMPANY_A, { id: NEW, startDate: '2026-03-10', deadline: '2026-03-09' }),
      ),
    );
    expect(message).toMatch(/tasks_deadline_after_start/);

    await asApp(
      COMPANY_A,
      insertTask(COMPANY_A, { id: NEW, startDate: '2026-03-10', deadline: '2026-03-10' }),
    );
  });

  it('refuses progress outside 0–100', async () => {
    for (const progress of ['-1', '100.01']) {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, insertTask(COMPANY_A, { id: NEW, progress })),
      );
      expect(message).toMatch(/tasks_progress_range/);
    }
  });

  it('refuses a cancelled task without a reason, or with only whitespace', async () => {
    for (const reason of [null, '   ']) {
      const message = await expectRejection(() =>
        asApp(
          COMPANY_A,
          insertTask(COMPANY_A, { id: NEW, status: 'cancelled', cancelledReason: reason }),
        ),
      );
      expect(message).toMatch(/tasks_cancellation_has_reason/);
    }
  });

  it('ties completed_at to the completed status, both ways', async () => {
    const without = await expectRejection(() =>
      asApp(COMPANY_A, insertTask(COMPANY_A, { id: NEW, status: 'completed' })),
    );
    expect(without).toMatch(/tasks_completed_at_consistent/);

    const stray = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertTask(COMPANY_A, {
          id: NEW,
          status: 'in_progress',
          completedAt: '2026-03-10T10:00:00Z',
        }),
      ),
    );
    expect(stray).toMatch(/tasks_completed_at_consistent/);
  });

  it('has no stored overdue status', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertTask(COMPANY_A, { id: NEW, status: 'overdue' })),
    );
    expect(message).toMatch(/invalid input value for enum task_status/);
  });

  it('the application role cannot hard-delete a task (soft delete only)', async () => {
    const message = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM tasks'));
    expect(message).toMatch(/permission denied/);
  });
});

describe('task_checklist_items — isolation through the parent task', () => {
  it('a bare SELECT returns only items under the caller company’s tasks', async () => {
    const rows = await asApp<{ id: string }>(COMPANY_A, 'SELECT * FROM task_checklist_items');
    expect(rows.map((row) => row.id)).toEqual([A.item]);
  });

  it('refuses to add an item under another company’s task', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertItem(B.task, '00000000-0000-7000-8000-00000000ccc1')),
    );
    expect(message).toMatch(/row-level security|policy/i);
  });

  it('an UPDATE or DELETE with no WHERE cannot reach another company’s items', async () => {
    await asApp(COMPANY_A, "UPDATE task_checklist_items SET title = 'Touched'");
    await asApp(COMPANY_A, 'DELETE FROM task_checklist_items');
    const other = await asApp<{ title: string }>(
      COMPANY_B,
      'SELECT title FROM task_checklist_items',
    );
    expect(other).toEqual([{ title: 'Draft' }]);
  });

  it('cannot move an item under another company’s task', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE task_checklist_items SET task_id = '${B.task}'`),
    );
    expect(message).toMatch(/row-level security|policy|same company|company/i);
  });

  it('refuses another company’s user as the one who ticked it', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertItem(A.task, '00000000-0000-7000-8000-00000000ccc2', {
          completed: true,
          completedBy: B.user,
        }),
      ),
    );
    expect(message).toMatch(/task's company/);
  });

  it('ties completed_at to is_completed, and refuses an empty title', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE task_checklist_items SET is_completed = true`),
    );
    expect(message).toMatch(/task_checklist_items_completion_consistent/);

    const empty = await expectRejection(() =>
      asApp(COMPANY_A, insertItem(A.task, '00000000-0000-7000-8000-00000000ccc3', { title: '  ' })),
    );
    expect(empty).toMatch(/task_checklist_items_title_present/);
  });

  it('the application role may remove an item outright (FLOW 11)', async () => {
    await asApp(COMPANY_A, `DELETE FROM task_checklist_items WHERE id = '${A.item}'`);
    const rows = await asApp(COMPANY_A, 'SELECT * FROM task_checklist_items');
    expect(rows).toHaveLength(0);
  });
});

describe('task_progress_updates — append-only, isolated through the task', () => {
  it('a bare SELECT returns only updates under the caller company’s tasks', async () => {
    const rows = await asApp<{ id: string }>(COMPANY_A, 'SELECT * FROM task_progress_updates');
    expect(rows.map((row) => row.id)).toEqual([A.update]);
  });

  it('refuses to add an update under another company’s task', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertUpdate(B.task, '00000000-0000-7000-8000-00000000ddd1', A.user)),
    );
    expect(message).toMatch(/row-level security|policy|company/i);
  });

  it('the application role can neither edit nor delete history (DOCUMENT 13 rule 9)', async () => {
    const update = await expectRejection(() =>
      asApp(COMPANY_A, "UPDATE task_progress_updates SET note = 'Rewritten'"),
    );
    expect(update).toMatch(/permission denied/);

    const remove = await expectRejection(() =>
      asApp(COMPANY_A, 'DELETE FROM task_progress_updates'),
    );
    expect(remove).toMatch(/permission denied/);
  });

  it('refuses an empty or whitespace note, and one over 2000 characters', async () => {
    for (const note of ['   ', 'x'.repeat(2001)]) {
      const message = await expectRejection(() =>
        asApp(
          COMPANY_A,
          insertUpdate(A.task, '00000000-0000-7000-8000-00000000ddd2', A.user, { note }),
        ),
      );
      expect(message).toMatch(/task_progress_updates_note_(present|length)/);
    }
  });

  it('refuses another company’s employee or user as the author', async () => {
    const employee = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertUpdate(A.task, '00000000-0000-7000-8000-00000000ddd3', A.user, {
          employee: B.employee,
        }),
      ),
    );
    expect(employee).toMatch(/task's company/);

    const user = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertUpdate(A.task, '00000000-0000-7000-8000-00000000ddd4', B.user, { employee: null }),
      ),
    );
    expect(user).toMatch(/task's company/);
  });

  it('accepts an update with no employee record (an administrator account)', async () => {
    await asApp(
      COMPANY_A,
      insertUpdate(A.task, '00000000-0000-7000-8000-00000000ddd5', A.user, { employee: null }),
    );
    const rows = await asApp(COMPANY_A, 'SELECT * FROM task_progress_updates');
    expect(rows).toHaveLength(2);
  });
});
