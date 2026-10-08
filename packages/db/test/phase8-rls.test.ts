/**
 * Phase 8 row-level security, reference integrity and table guarantees —
 * AD-03, DOCUMENT 06 §3.18–3.19, DOCUMENT 07 §9 invariant 7, DOCUMENT 14,
 * DOCUMENT 26 §5.
 *
 * Same approach as `phase7-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: a history table that refuses UPDATE and DELETE to
 * every role (the owner included), a per-company configuration row the
 * database itself writes when a company is created, and a reference added to
 * an existing table (`tasks.goal_id`).
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

const PHASE8 = '20261006000000_phase8_goals_performance';

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
    goal: '00000000-0000-7000-8000-0000000001c1',
    progress: '00000000-0000-7000-8000-0000000001f1',
    task: '00000000-0000-7000-8000-000000000171',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    goal: '00000000-0000-7000-8000-0000000002c2',
    progress: '00000000-0000-7000-8000-0000000002f2',
    task: '00000000-0000-7000-8000-000000000272',
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

interface GoalOverrides {
  readonly id?: string;
  readonly employee?: string;
  readonly createdBy?: string;
  readonly type?: 'sales' | 'task' | 'custom';
  readonly title?: string;
  readonly target?: string;
  readonly current?: string;
  readonly unit?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly rule?: string | null;
}

function insertGoal(companyId: string, overrides: GoalOverrides = {}): string {
  const own = IDS[companyId as keyof typeof IDS];
  const type = overrides.type ?? 'sales';
  const rule =
    overrides.rule === undefined
      ? type === 'task'
        ? `'{"version":1,"priorities":["low","medium","high","urgent"]}'::jsonb`
        : 'NULL'
      : overrides.rule === null
        ? 'NULL'
        : `'${overrides.rule}'::jsonb`;
  return `INSERT INTO goals
            (id, company_id, employee_id, type, title, target_value, current_value, unit,
             period_start, period_end, task_count_rule, created_by, updated_at)
          VALUES ('${overrides.id ?? '00000000-0000-7000-8000-00000000ffff'}', '${companyId}',
            '${overrides.employee ?? own.employee}', '${type}',
            '${overrides.title ?? 'Quarterly sales'}', ${overrides.target ?? '100000'},
            ${overrides.current ?? '0'}, '${overrides.unit ?? 'EGP'}',
            DATE '${overrides.periodStart ?? '2026-03-01'}',
            DATE '${overrides.periodEnd ?? '2026-03-31'}', ${rule},
            '${overrides.createdBy ?? own.user}', now())`;
}

function insertProgress(
  goalId: string,
  id: string,
  createdBy: string,
  overrides: { value?: string; previous?: string | null; target?: string; note?: string } = {},
): string {
  const previous = overrides.previous === undefined ? 'NULL' : (overrides.previous ?? 'NULL');
  return `INSERT INTO goal_progress
            (id, goal_id, value, previous_value, target_value, note, source, created_by)
          VALUES ('${id}', '${goalId}', ${overrides.value ?? '0'}, ${previous},
            ${overrides.target ?? '100000'},
            ${overrides.note === undefined ? 'NULL' : `'${overrides.note}'`}, 'manual',
            '${createdBy}')`;
}

function insertTask(companyId: string, id: string, goalId: string | null): string {
  const own = IDS[companyId as keyof typeof IDS];
  return `INSERT INTO tasks
            (id, company_id, title, assignee_employee_id, priority, status, progress_percent,
             created_by, goal_id, updated_at)
          VALUES ('${id}', '${companyId}', 'Call the client', '${own.employee}', 'medium',
            'not_started', 0, '${own.user}', ${goalId === null ? 'NULL' : `'${goalId}'`}, now())`;
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
          '${own.schedule}', DATE '2026-01-15', now());`,
  );
}

async function seedRole(): Promise<void> {
  await db.exec(
    `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
     VALUES ('${ROLE}', NULL, 'employee', 'Employee', 'موظف', true, now());`,
  );
}

beforeEach(async () => {
  db = new PGlite();
  for (const name of MIGRATION_NAMES) {
    await db.exec(migrationSql(name));
  }
  await seedRole();

  for (const [companyId, slug] of [
    [COMPANY_A, 'company-a'],
    [COMPANY_B, 'company-b'],
  ] as const) {
    const own = IDS[companyId];
    await seedCompany(companyId, slug);
    await asOwner(
      companyId,
      `${insertGoal(companyId, { id: own.goal })};
       ${insertProgress(own.goal, own.progress, own.user)};
       ${insertTask(companyId, own.task, own.goal)};`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

describe('goals — tenant isolation', () => {
  it('a bare SELECT returns only the caller company’s rows', async () => {
    const rows = await asApp<{ company_id: string }>(COMPANY_A, 'SELECT * FROM goals');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.company_id).toBe(COMPANY_A);
  });

  it('naming another company’s goal by primary key still finds nothing', async () => {
    const rows = await asApp(COMPANY_A, `SELECT * FROM goals WHERE id = '${B.goal}'`);
    expect(rows).toHaveLength(0);
  });

  it('with no tenant bound, the role sees no goals at all', async () => {
    const rows = await asApp('', 'SELECT * FROM goals');
    expect(rows).toHaveLength(0);
  });

  it('refuses to insert a goal for another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_B, { id: '00000000-0000-7000-8000-00000000aaaa' })),
    );
    expect(message).toMatch(/row-level security|policy|same company/i);
  });

  it('an UPDATE with no WHERE cannot reach another company’s goal', async () => {
    await asApp(COMPANY_A, "UPDATE goals SET title = 'Touched by A'");
    const other = await asApp<{ title: string }>(COMPANY_B, 'SELECT title FROM goals');
    expect(other[0]?.title).toBe('Quarterly sales');
  });

  it('cannot move a goal into another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE goals SET company_id = '${COMPANY_B}'`),
    );
    expect(message).toMatch(/row-level security|policy|same company/i);
  });
});

describe('goals — same-company references', () => {
  it('refuses another company’s employee as owner', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertGoal(COMPANY_A, { id: '00000000-0000-7000-8000-00000000aab1', employee: B.employee }),
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('refuses another company’s user as creator', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertGoal(COMPANY_A, { id: '00000000-0000-7000-8000-00000000aab2', createdBy: B.user }),
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('refuses moving an existing goal to another company’s employee', async () => {
    const message = await expectRejection(() =>
      asOwner(COMPANY_A, `UPDATE goals SET employee_id = '${B.employee}' WHERE id = '${A.goal}'`),
    );
    expect(message).toMatch(/same company/);
  });
});

describe('goals — table guarantees (DOCUMENT 14)', () => {
  const NEW = '00000000-0000-7000-8000-00000000bbb1';

  it('refuses a zero or negative target — it would divide by zero', async () => {
    for (const target of ['0', '-5']) {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, target })),
      );
      expect(message).toMatch(/goals_target_positive/);
    }
  });

  it('refuses a negative current value', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, current: '-1' })),
    );
    expect(message).toMatch(/goals_current_non_negative/);
  });

  it('refuses a period that does not end after it starts (the same day included)', async () => {
    for (const periodEnd of ['2026-03-01', '2026-02-28']) {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, periodStart: '2026-03-01', periodEnd })),
      );
      expect(message).toMatch(/goals_period_order/);
    }
  });

  it('requires a counting rule on a task goal, and only there', async () => {
    const missing = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, type: 'task', rule: null })),
    );
    expect(missing).toMatch(/goals_task_rule_matches_type/);

    const stray = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, type: 'custom', rule: '{"version":1}' })),
    );
    expect(stray).toMatch(/goals_task_rule_matches_type/);

    const notObject = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, type: 'task', rule: '[1,2]' })),
    );
    expect(notObject).toMatch(/goals_task_rule_is_object/);
  });

  it('refuses a blank title or unit', async () => {
    const title = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, title: '   ' })),
    );
    expect(title).toMatch(/goals_title_present/);
    const unit = await expectRejection(() =>
      asApp(COMPANY_A, insertGoal(COMPANY_A, { id: NEW, unit: ' ' })),
    );
    expect(unit).toMatch(/goals_unit_present/);
  });

  it('has no DELETE for the application — goals are soft-deleted (DOCUMENT 06 §6)', async () => {
    const message = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM goals'));
    expect(message).toMatch(/permission denied/);
    await asApp(COMPANY_A, 'UPDATE goals SET deleted_at = now()');
  });
});

// ---------------------------------------------------------------------------
// goal_progress
// ---------------------------------------------------------------------------

describe('goal_progress — tenant isolation through the goal', () => {
  it('a bare SELECT returns only rows under the caller company’s goals', async () => {
    const rows = await asApp<{ goal_id: string }>(COMPANY_A, 'SELECT * FROM goal_progress');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.goal_id).toBe(A.goal);
  });

  it('with no tenant bound, nothing is visible', async () => {
    const rows = await asApp('', 'SELECT * FROM goal_progress');
    expect(rows).toHaveLength(0);
  });

  it('refuses a row under another company’s goal', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertProgress(B.goal, '00000000-0000-7000-8000-00000000ccc1', A.user, { value: '5' }),
      ),
    );
    // The same-company trigger's own lookup of the goal is row-secured, so it
    // is the guard that refuses first; the policy would refuse too.
    expect(message).toMatch(/row-level security|policy|goal's company/i);
  });

  it('refuses another company’s user as the author', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        insertProgress(A.goal, '00000000-0000-7000-8000-00000000ccc2', B.user, { value: '5' }),
      ),
    );
    expect(message).toMatch(/goal's company/);
  });
});

describe('goal_progress — append-only (DOCUMENT 14 rules 5 and 9)', () => {
  it('the application can append', async () => {
    await asApp(
      COMPANY_A,
      insertProgress(A.goal, '00000000-0000-7000-8000-00000000ddd1', A.user, {
        value: '75000',
        previous: '0',
        note: 'Q1 invoices',
      }),
    );
    const rows = await asApp(COMPANY_A, 'SELECT * FROM goal_progress');
    expect(rows).toHaveLength(2);
  });

  it('the application can neither UPDATE nor DELETE a row', async () => {
    const update = await expectRejection(() =>
      asApp(COMPANY_A, 'UPDATE goal_progress SET value = 1'),
    );
    expect(update).toMatch(/permission denied/);
    const remove = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM goal_progress'));
    expect(remove).toMatch(/permission denied/);
  });

  it('not even the table owner can rewrite history', async () => {
    const update = await expectRejection(() =>
      asOwner(COMPANY_A, 'UPDATE goal_progress SET value = 1'),
    );
    expect(update).toMatch(/append-only/);
    const remove = await expectRejection(() => asOwner(COMPANY_A, 'DELETE FROM goal_progress'));
    expect(remove).toMatch(/append-only/);
  });

  it('a goal with history cannot be hard-deleted out from under it', async () => {
    const message = await expectRejection(() =>
      asOwner(COMPANY_A, `DELETE FROM goals WHERE id = '${A.goal}'`),
    );
    expect(message).toMatch(/goal_progress_goal_id_fkey|foreign key/);
  });

  it('refuses a negative value, a zero target or a blank note', async () => {
    const value = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertProgress(A.goal, '00000000-0000-7000-8000-00000000ddd2', A.user, { value: '-1' }),
      ),
    );
    expect(value).toMatch(/goal_progress_value_non_negative/);
    const target = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertProgress(A.goal, '00000000-0000-7000-8000-00000000ddd3', A.user, { target: '0' }),
      ),
    );
    expect(target).toMatch(/goal_progress_target_positive/);
    const note = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertProgress(A.goal, '00000000-0000-7000-8000-00000000ddd4', A.user, { note: '  ' }),
      ),
    );
    expect(note).toMatch(/goal_progress_note_present/);
  });
});

// ---------------------------------------------------------------------------
// tasks.goal_id
// ---------------------------------------------------------------------------

describe('tasks.goal_id — DOCUMENT 13 "Database requirements"', () => {
  it('refuses linking a task to another company’s goal', async () => {
    const message = await expectRejection(() =>
      asOwner(COMPANY_A, `UPDATE tasks SET goal_id = '${B.goal}' WHERE id = '${A.task}'`),
    );
    expect(message).toMatch(/same company/);
  });

  it('is SET NULL when the goal row is deleted', async () => {
    const bare = '00000000-0000-7000-8000-00000000eee1';
    const task = '00000000-0000-7000-8000-00000000eee2';
    await asOwner(
      COMPANY_A,
      `${insertGoal(COMPANY_A, { id: bare })}; ${insertTask(COMPANY_A, task, bare)};`,
    );
    await asOwner(COMPANY_A, `DELETE FROM goals WHERE id = '${bare}'`);
    const rows = await asApp<{ goal_id: string | null }>(
      COMPANY_A,
      `SELECT goal_id FROM tasks WHERE id = '${task}'`,
    );
    expect(rows[0]?.goal_id).toBeNull();
  });

  it('every pre-existing task write still works without a goal', async () => {
    await asApp(COMPANY_A, insertTask(COMPANY_A, '00000000-0000-7000-8000-00000000eee3', null));
  });
});

// ---------------------------------------------------------------------------
// performance_config
// ---------------------------------------------------------------------------

interface ConfigRow {
  readonly id: string;
  readonly company_id: string;
  readonly schema_version: number;
  readonly config: {
    readonly weights: Record<string, string>;
    readonly attendance: Record<string, string>;
    readonly task: Record<string, string>;
  };
  readonly updated_by: string | null;
}

describe('performance_config — one documented default per company', () => {
  it('a new company receives the DOCUMENT 14 default model, as data', async () => {
    const rows = await asApp<ConfigRow>(COMPANY_A, 'SELECT * FROM performance_config');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.schema_version).toBe(1);
    expect(rows[0]?.updated_by).toBeNull();
    expect(rows[0]?.config).toEqual({
      weights: { attendance: '0.3000', task: '0.4000', goal: '0.3000' },
      attendance: { late_penalty: '1.00', absence_penalty: '5.00' },
      task: { completion_weight: '0.6000', on_time_weight: '0.4000' },
    });
  });

  it('the row the database writes carries a time-ordered UUID v7 key (OD-12)', async () => {
    const rows = await asApp<ConfigRow>(COMPANY_A, 'SELECT id FROM performance_config');
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-/);
  });

  it('companies that existed before the migration are backfilled', async () => {
    const fresh = new PGlite();
    try {
      for (const name of MIGRATION_NAMES.filter((candidate) => candidate < PHASE8)) {
        await fresh.exec(migrationSql(name));
      }
      await fresh.exec(
        `INSERT INTO companies (id, name, slug, timezone, updated_at)
         VALUES ('${COMPANY_A}', 'old', 'old', 'Africa/Cairo', now());`,
      );
      await fresh.exec(migrationSql(PHASE8));
      const rows = await fresh.query<{ company_id: string }>(
        'SELECT company_id FROM performance_config',
      );
      expect(rows.rows.map((row) => row.company_id)).toEqual([COMPANY_A]);
    } finally {
      await fresh.close();
    }
  });

  it('is isolated per company', async () => {
    const rows = await asApp<ConfigRow>(COMPANY_A, 'SELECT * FROM performance_config');
    expect(rows.every((row) => row.company_id === COMPANY_A)).toBe(true);
    expect(await asApp('', 'SELECT * FROM performance_config')).toHaveLength(0);
  });

  it('the application may update its own row and nothing else', async () => {
    await asApp(
      COMPANY_A,
      `UPDATE performance_config SET config = '{"weights":{}}'::jsonb, updated_by = '${A.user}'`,
    );
    const other = await asApp<ConfigRow>(COMPANY_B, 'SELECT config FROM performance_config');
    expect(other[0]?.config.weights).toEqual({
      attendance: '0.3000',
      task: '0.4000',
      goal: '0.3000',
    });
  });

  it('the application can neither INSERT nor DELETE a configuration', async () => {
    const insert = await expectRejection(() =>
      asApp(
        COMPANY_A,
        `INSERT INTO performance_config (id, company_id, schema_version, config)
         VALUES ('00000000-0000-7000-8000-00000000fff1', '${COMPANY_A}', 1, '{}'::jsonb)`,
      ),
    );
    expect(insert).toMatch(/permission denied/);
    const remove = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM performance_config'));
    expect(remove).toMatch(/permission denied/);
  });

  it('refuses another company’s user as the editor', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `UPDATE performance_config SET updated_by = '${B.user}' WHERE company_id = '${COMPANY_A}'`,
      ),
    );
    expect(message).toMatch(/same company/);
  });

  it('keeps one row per company', async () => {
    const message = await expectRejection(() =>
      asOwner(
        COMPANY_A,
        `INSERT INTO performance_config (id, company_id, schema_version, config)
         VALUES ('00000000-0000-7000-8000-00000000fff2', '${COMPANY_A}', 1, '{}'::jsonb)`,
      ),
    );
    expect(message).toMatch(/performance_config_company_id_key|duplicate/);
  });
});
