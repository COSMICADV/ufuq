/**
 * Phase 9 row-level security, reference integrity and table guarantees —
 * AD-03, DOCUMENT 06 §3.20, DOCUMENT 07 §9 invariant 7, OD-09, DOCUMENT 26 §5.
 *
 * Same approach as `phase8-rls.test.ts`: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: an inbox table whose attendance rows are written by the
 * database itself from the specialised correction record (the OD-09 hybrid
 * model), a polymorphic `related_id` checked by type, and a category (leave)
 * that the table refuses until its specialised record exists (Phase 10).
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

const PHASE9 = '20261008000000_phase9_requests';

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
    task: '00000000-0000-7000-8000-000000000171',
    request: '00000000-0000-7000-8000-0000000001c1',
    correction: '00000000-0000-7000-8000-0000000001d1',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    colleague: '00000000-0000-7000-8000-0000000002b3',
    colleagueUser: '00000000-0000-7000-8000-0000000002a3',
    task: '00000000-0000-7000-8000-000000000272',
    request: '00000000-0000-7000-8000-0000000002c2',
    correction: '00000000-0000-7000-8000-0000000002d2',
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

interface RequestOverrides {
  readonly id?: string;
  readonly employee?: string;
  readonly category?: 'attendance' | 'leave' | 'salary' | 'task' | 'general';
  readonly subject?: string | null;
  readonly description?: string | null;
  readonly relatedType?: string | null;
  readonly relatedId?: string | null;
  readonly status?: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly reviewedBy?: string | null;
  readonly reviewedAt?: string | null;
  readonly response?: string | null;
}

function literal(value: string | null | undefined, fallback: string | null): string {
  const chosen = value === undefined ? fallback : value;
  return chosen === null ? 'NULL' : `'${chosen}'`;
}

function insertRequest(companyId: string, overrides: RequestOverrides = {}): string {
  const own = IDS[companyId as keyof typeof IDS];
  return `INSERT INTO requests
            (id, company_id, employee_id, category, subject, description, related_type,
             related_id, status, reviewed_by, reviewed_at, admin_response)
          VALUES ('${overrides.id ?? '00000000-0000-7000-8000-00000000ffff'}', '${companyId}',
            '${overrides.employee ?? own.employee}', '${overrides.category ?? 'general'}',
            ${literal(overrides.subject, 'Parking permit')},
            ${literal(overrides.description, 'I need a parking permit for March.')},
            ${literal(overrides.relatedType, null)}, ${literal(overrides.relatedId, null)},
            '${overrides.status ?? 'pending'}', ${literal(overrides.reviewedBy, null)},
            ${overrides.reviewedAt === undefined || overrides.reviewedAt === null ? 'NULL' : `TIMESTAMPTZ '${overrides.reviewedAt}'`},
            ${literal(overrides.response, null)})`;
}

function insertCorrection(companyId: string, id: string, employee?: string): string {
  const own = IDS[companyId as keyof typeof IDS];
  return `INSERT INTO attendance_correction_requests
            (id, company_id, employee_id, date, requested_work_mode, reason, status, updated_at)
          VALUES ('${id}', '${companyId}', '${employee ?? own.employee}', DATE '2026-03-09',
            'office', 'Forgot to check in', 'pending', now())`;
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
          'Person', '${own.schedule}', DATE '2026-01-15', now());
     INSERT INTO tasks (id, company_id, title, assignee_employee_id, priority, status,
          progress_percent, created_by, updated_at)
       VALUES ('${own.task}', '${companyId}', 'Call the client', '${own.employee}', 'medium',
          'not_started', 0, '${own.user}', now());`,
  );
}

async function seedRole(): Promise<void> {
  await db.exec(
    `INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
     VALUES ('${ROLE}', NULL, 'employee', 'Employee', 'موظف', true, now());`,
  );
}

async function migrate(names: readonly string[]): Promise<void> {
  for (const name of names) {
    await db.exec(migrationSql(name));
  }
}

describe('with every migration applied', () => {
  beforeEach(async () => {
    db = new PGlite();
    await migrate(MIGRATION_NAMES);
    await seedRole();
    for (const [companyId, slug] of [
      [COMPANY_A, 'company-a'],
      [COMPANY_B, 'company-b'],
    ] as const) {
      await seedCompany(companyId, slug);
      await asOwner(companyId, insertRequest(companyId, { id: IDS[companyId].request }));
    }
  });

  afterEach(async () => {
    await db.close();
  });

  describe('requests — tenant isolation', () => {
    it('a bare SELECT returns only the caller company’s rows', async () => {
      const rows = await asApp<{ company_id: string }>(COMPANY_A, 'SELECT * FROM requests');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.company_id).toBe(COMPANY_A);
    });

    it('naming another company’s request by primary key still finds nothing', async () => {
      const rows = await asApp(COMPANY_A, `SELECT * FROM requests WHERE id = '${B.request}'`);
      expect(rows).toHaveLength(0);
    });

    it('with no tenant bound, the role sees no requests at all', async () => {
      expect(await asApp('', 'SELECT * FROM requests')).toHaveLength(0);
    });

    it('refuses to insert a request for another company', async () => {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, insertRequest(COMPANY_B, { id: '00000000-0000-7000-8000-00000000aaaa' })),
      );
      expect(message).toMatch(/row-level security|policy|same company/i);
    });

    it('an UPDATE with no WHERE cannot reach another company’s request', async () => {
      await asApp(COMPANY_A, "UPDATE requests SET status = 'cancelled'");
      const other = await asApp<{ status: string }>(COMPANY_B, 'SELECT status FROM requests');
      expect(other[0]?.status).toBe('pending');
    });

    it('the application role cannot delete a request — requests are history', async () => {
      const message = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM requests'));
      expect(message).toMatch(/permission denied/i);
    });
  });

  describe('requests — same-company references (DOCUMENT 07 §9 invariant 7)', () => {
    it('refuses another company’s employee', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aab1',
            employee: B.employee,
          }),
        ),
      );
      expect(message).toMatch(/same company/);
    });

    it('refuses another company’s reviewer', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aab2',
            status: 'approved',
            reviewedBy: B.user,
            reviewedAt: '2026-03-10T08:00:00Z',
          }),
        ),
      );
      expect(message).toMatch(/same company/);
    });

    it('a task request may reference only a task of its own company', async () => {
      await asOwner(
        COMPANY_A,
        insertRequest(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000aab3',
          category: 'task',
          relatedType: 'task',
          relatedId: A.task,
        }),
      );
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aab4',
            category: 'task',
            relatedType: 'task',
            relatedId: B.task,
          }),
        ),
      );
      expect(message).toMatch(/same company/);
    });

    it('an attendance row must point at this employee’s own correction', async () => {
      await asOwner(COMPANY_A, insertCorrection(COMPANY_A, A.correction, A.colleague));
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aab5',
            category: 'attendance',
            subject: null,
            description: null,
            relatedType: 'attendance_correction_request',
            relatedId: A.correction,
          }),
        ),
      );
      // Either the employee mismatch or the one-row-per-record index refuses it.
      expect(message).toMatch(/same company|duplicate key/);
    });
  });

  describe('requests — the shape of each category (OD-09)', () => {
    it('a native request needs a subject and a description', async () => {
      for (const missing of [{ subject: null }, { description: null }, { subject: '   ' }]) {
        await expectRejection(() =>
          asOwner(
            COMPANY_A,
            insertRequest(COMPANY_A, { id: '00000000-0000-7000-8000-00000000aac1', ...missing }),
          ),
        );
      }
    });

    it('salary and general requests reference nothing; only a task request may name a task', async () => {
      for (const category of ['salary', 'general'] as const) {
        const message = await expectRejection(() =>
          asOwner(
            COMPANY_A,
            insertRequest(COMPANY_A, {
              id: '00000000-0000-7000-8000-00000000aac2',
              category,
              relatedType: 'task',
              relatedId: A.task,
            }),
          ),
        );
        expect(message).toMatch(/requests_category_shape/);
      }
    });

    it('an attendance row must point at a correction', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aac3',
            category: 'attendance',
          }),
        ),
      );
      expect(message).toMatch(/requests_category_shape/);
    });

    it('a leave row cannot be written until Phase 10 creates leave_requests', async () => {
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aac4',
            category: 'leave',
            relatedType: 'leave_request',
            relatedId: '00000000-0000-7000-8000-00000000eeee',
          }),
        ),
      );
      expect(message).toMatch(/Phase 10/);
      const generic = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            id: '00000000-0000-7000-8000-00000000aac5',
            category: 'leave',
          }),
        ),
      );
      expect(generic).toMatch(/requests_category_shape/);
    });

    it('a rejection carries a reason; a decision carries its time; an open request has none', async () => {
      const base = { id: '00000000-0000-7000-8000-00000000aac6', reviewedBy: A.colleagueUser };
      const noReason = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, {
            ...base,
            status: 'rejected',
            reviewedAt: '2026-03-10T08:00:00Z',
            response: ' ',
          }),
        ),
      );
      expect(noReason).toMatch(/requests_rejection_has_reason/);
      const noTime = await expectRejection(() =>
        asOwner(COMPANY_A, insertRequest(COMPANY_A, { ...base, status: 'approved' })),
      );
      expect(noTime).toMatch(/requests_review_consistent/);
      const pendingWithTime = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          insertRequest(COMPANY_A, { ...base, reviewedAt: '2026-03-10T08:00:00Z' }),
        ),
      );
      expect(pendingWithTime).toMatch(/requests_review_consistent/);
      await asOwner(
        COMPANY_A,
        insertRequest(COMPANY_A, {
          ...base,
          status: 'rejected',
          reviewedAt: '2026-03-10T08:00:00Z',
          response: 'Budget is closed',
        }),
      );
    });

    it('has DOCUMENT 06 §3.20’s inbox index', async () => {
      const result = await db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'requests_company_id_status_created_at_idx'",
      );
      expect(result.rows[0]?.indexdef).toMatch(/\(company_id, status, created_at\)/);
    });
  });

  describe('the hybrid index for attendance corrections', () => {
    it('writing a correction writes its inbox row, under the caller’s own tenant', async () => {
      await asApp(COMPANY_A, insertCorrection(COMPANY_A, A.correction));
      const rows = await asApp<{
        category: string;
        related_type: string;
        employee_id: string;
        status: string;
      }>(COMPANY_A, `SELECT * FROM requests WHERE related_id = '${A.correction}'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        category: 'attendance',
        related_type: 'attendance_correction_request',
        employee_id: A.employee,
        status: 'pending',
      });
      expect(
        await asApp(COMPANY_B, `SELECT * FROM requests WHERE related_id = '${A.correction}'`),
      ).toHaveLength(0);
    });

    it('deciding the correction moves its inbox row with it', async () => {
      await asApp(COMPANY_A, insertCorrection(COMPANY_A, A.correction));
      await asApp(
        COMPANY_A,
        `UPDATE attendance_correction_requests
           SET status = 'rejected', reviewed_by = '${A.colleagueUser}',
               reviewed_at = TIMESTAMPTZ '2026-03-10T08:00:00Z', review_note = 'No evidence'
         WHERE id = '${A.correction}'`,
      );
      const rows = await asApp<{
        status: string;
        reviewed_by: string;
        admin_response: string;
        reviewed_at: Date;
      }>(COMPANY_A, `SELECT * FROM requests WHERE related_id = '${A.correction}'`);
      expect(rows[0]).toMatchObject({
        status: 'rejected',
        reviewed_by: A.colleagueUser,
        admin_response: 'No evidence',
      });
      expect(rows[0]?.reviewed_at).not.toBeNull();
    });

    it('cancelling the correction cancels its inbox row', async () => {
      await asApp(COMPANY_A, insertCorrection(COMPANY_A, A.correction));
      await asApp(
        COMPANY_A,
        `UPDATE attendance_correction_requests SET status = 'cancelled' WHERE id = '${A.correction}'`,
      );
      const rows = await asApp<{ status: string }>(
        COMPANY_A,
        `SELECT status FROM requests WHERE related_id = '${A.correction}'`,
      );
      expect(rows[0]?.status).toBe('cancelled');
    });
  });

  describe('attachments', () => {
    it('accept a request as their record', async () => {
      await asOwner(
        COMPANY_A,
        `INSERT INTO attachments
           (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes,
            checksum, related_type, related_id)
         VALUES ('00000000-0000-7000-8000-00000000bbb1', '${COMPANY_A}', '${A.user}', 'a.pdf',
           '${COMPANY_A}/bbb1', 'application/pdf', 10, '${'a'.repeat(64)}', 'request', '${A.request}')`,
      );
      const message = await expectRejection(() =>
        asOwner(
          COMPANY_A,
          `INSERT INTO attachments
             (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes,
              checksum, related_type, related_id)
           VALUES ('00000000-0000-7000-8000-00000000bbb2', '${COMPANY_A}', '${A.user}', 'a.pdf',
             '${COMPANY_A}/bbb2', 'application/pdf', 10, '${'a'.repeat(64)}', 'payslip', '${A.request}')`,
        ),
      );
      expect(message).toMatch(/attachments_related_type_known/);
    });
  });
});

describe('the backfill — corrections that predate Phase 9', () => {
  afterEach(async () => {
    await db.close();
  });

  it('every existing correction gets one inbox row carrying its decision', async () => {
    db = new PGlite();
    await migrate(MIGRATION_NAMES.filter((name) => name < PHASE9));
    await seedRole();
    await seedCompany(COMPANY_A, 'company-a');
    await asOwner(
      COMPANY_A,
      `${insertCorrection(COMPANY_A, A.correction)};
       ${insertCorrection(COMPANY_A, '00000000-0000-7000-8000-0000000001d2', A.colleague)};
       UPDATE attendance_correction_requests
         SET status = 'approved', reviewed_by = '${A.colleagueUser}',
             reviewed_at = TIMESTAMPTZ '2026-03-10T08:00:00Z', review_note = 'OK'
       WHERE id = '${A.correction}';`,
    );

    await migrate(MIGRATION_NAMES.filter((name) => name >= PHASE9));

    const rows = await asApp<{
      related_id: string;
      status: string;
      admin_response: string | null;
      id: string;
    }>(COMPANY_A, 'SELECT * FROM requests ORDER BY related_id');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      related_id: A.correction,
      status: 'approved',
      admin_response: 'OK',
    });
    expect(rows[1]).toMatchObject({ status: 'pending', admin_response: null });
    // OD-12: a database-written key is a version-7 UUID.
    expect(rows[0]?.id[14]).toBe('7');
  });
});
