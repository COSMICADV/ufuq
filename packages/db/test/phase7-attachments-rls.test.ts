/**
 * The attachment store — row-level security, reference integrity and table
 * guarantees. AD-03, DOCUMENT 06 §3.36, DOCUMENT 07 §9 invariant 7,
 * DOCUMENT 20 §§3 and 7, DOCUMENT 26 §5.
 *
 * Same approach as every earlier RLS suite: the real migration files, a real
 * PostgreSQL engine (PGlite), the restricted `ufuq_app` role, and queries with
 * no `WHERE` clause.
 *
 * What is new in kind: a polymorphic reference (`related_type`/`related_id`)
 * with no foreign key, so the same-company trigger is the only thing standing
 * between a row and another company's record; and a storage key the database
 * itself requires to be company-namespaced.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

const MIGRATIONS = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .map((name) => readFileSync(`${MIGRATIONS_DIRECTORY}${name}/migration.sql`, 'utf8'));

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE = '00000000-0000-7000-8000-0000000000a0';

const IDS = {
  [COMPANY_A]: {
    user: '00000000-0000-7000-8000-0000000001a1',
    schedule: '00000000-0000-7000-8000-0000000001e1',
    employee: '00000000-0000-7000-8000-0000000001b1',
    task: '00000000-0000-7000-8000-0000000001c1',
    attachment: '00000000-0000-7000-8000-0000000001f1',
  },
  [COMPANY_B]: {
    user: '00000000-0000-7000-8000-0000000002a2',
    schedule: '00000000-0000-7000-8000-0000000002e2',
    employee: '00000000-0000-7000-8000-0000000002b2',
    task: '00000000-0000-7000-8000-0000000002c2',
    attachment: '00000000-0000-7000-8000-0000000002f2',
  },
} as const;

const A = IDS[COMPANY_A];
const B = IDS[COMPANY_B];
const CHECKSUM = 'a'.repeat(64);

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

interface AttachmentOverrides {
  readonly id?: string;
  readonly uploadedBy?: string;
  readonly name?: string;
  readonly path?: string;
  readonly mime?: string;
  readonly size?: number;
  readonly checksum?: string;
  readonly relatedType?: string;
  readonly relatedId?: string;
}

function insertAttachment(companyId: string, overrides: AttachmentOverrides = {}): string {
  const own = IDS[companyId as keyof typeof IDS];
  const id = overrides.id ?? '00000000-0000-7000-8000-00000000ffff';
  return `INSERT INTO attachments
            (id, company_id, uploaded_by, original_name, stored_path, mime_type, size_bytes,
             checksum, related_type, related_id)
          VALUES ('${id}', '${companyId}', '${overrides.uploadedBy ?? own.user}',
            '${overrides.name ?? 'report.pdf'}',
            '${overrides.path ?? `${companyId}/${id.replace(/-/g, '')}`}',
            '${overrides.mime ?? 'application/pdf'}', ${String(overrides.size ?? 1024)},
            '${overrides.checksum ?? CHECKSUM}', '${overrides.relatedType ?? 'task'}',
            '${overrides.relatedId ?? own.task}')`;
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
       INSERT INTO tasks (id, company_id, title, assignee_employee_id, priority, status,
            progress_percent, created_by, updated_at)
         VALUES ('${own.task}', '${companyId}', 'Prepare the report', '${own.employee}',
            'medium', 'not_started', 0, '${own.user}', now());
       ${insertAttachment(companyId, { id: own.attachment })};`,
    );
  }
});

afterEach(async () => {
  await db.close();
});

describe('attachments — tenant isolation', () => {
  it('a bare SELECT returns only the caller company’s rows', async () => {
    const rows = await asApp<{ id: string }>(COMPANY_A, 'SELECT id FROM attachments');
    expect(rows).toEqual([{ id: A.attachment }]);
    const other = await asApp<{ id: string }>(COMPANY_B, 'SELECT id FROM attachments');
    expect(other).toEqual([{ id: B.attachment }]);
  });

  it('naming another company’s attachment by primary key finds nothing — DOCUMENT 26 §5', async () => {
    expect(
      await asApp(COMPANY_A, `SELECT * FROM attachments WHERE id = '${B.attachment}'`),
    ).toEqual([]);
  });

  it('with no tenant bound, the role sees no attachments at all', async () => {
    expect(await asApp('', 'SELECT * FROM attachments')).toEqual([]);
  });

  it('refuses to write a row for another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertAttachment(COMPANY_B, { id: '00000000-0000-7000-8000-00000000aaaa' })),
    );
    expect(message).toMatch(/row-level security|policy|same company/i);
  });

  it('an UPDATE with no WHERE cannot reach another company’s row', async () => {
    await asApp(COMPANY_A, 'UPDATE attachments SET deleted_at = now()');
    const other = await asApp<{ deleted_at: string | null }>(
      COMPANY_B,
      'SELECT deleted_at FROM attachments',
    );
    expect(other[0]?.deleted_at).toBeNull();
  });

  it('cannot move a row into another company', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, `UPDATE attachments SET company_id = '${COMPANY_B}'`),
    );
    expect(message).toMatch(/row-level security|policy|same company|namespaced/i);
  });
});

describe('attachments — reference integrity (DOCUMENT 07 §9 invariant 7)', () => {
  it('refuses to attach to another company’s task, which has no foreign key to stop it', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertAttachment(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000aaab',
          relatedId: B.task,
        }),
      ),
    );
    expect(message).toMatch(/same company/i);
  });

  it('refuses an uploader from another company', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertAttachment(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000aaac',
          uploadedBy: B.user,
        }),
      ),
    );
    expect(message).toMatch(/same company|foreign key/i);
  });

  it('refuses a related type no consumer has registered', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertAttachment(COMPANY_A, {
          id: '00000000-0000-7000-8000-00000000aaad',
          relatedType: 'employee',
        }),
      ),
    );
    expect(message).toMatch(/related_type_known/);
  });
});

describe('attachments — what a row may hold (DOCUMENT 20 §7)', () => {
  const NEW_ID = '00000000-0000-7000-8000-00000000abcd';

  it.each([
    ['application/pdf'],
    ['image/png'],
    ['image/jpeg'],
    ['image/webp'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('accepts %s', async (mime) => {
    await asApp(COMPANY_A, insertAttachment(COMPANY_A, { id: NEW_ID, mime }));
    expect(await asApp(COMPANY_A, `SELECT 1 FROM attachments WHERE id = '${NEW_ID}'`)).toHaveLength(
      1,
    );
  });

  it.each([
    ['application/x-msdownload'],
    ['text/html'],
    ['image/svg+xml'],
    ['application/zip'],
    ['application/vnd.ms-excel.sheet.macroEnabled.12'],
  ])('refuses %s', async (mime) => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertAttachment(COMPANY_A, { id: NEW_ID, mime })),
    );
    expect(message).toMatch(/mime_type_allowed/);
  });

  it('requires the storage key to sit under the row’s own company — DOCUMENT 20 §3', async () => {
    const message = await expectRejection(() =>
      asApp(COMPANY_A, insertAttachment(COMPANY_A, { id: NEW_ID, path: `${COMPANY_B}/stolen` })),
    );
    expect(message).toMatch(/company_namespaced/);
  });

  it('refuses a storage key already in use', async () => {
    const message = await expectRejection(() =>
      asApp(
        COMPANY_A,
        insertAttachment(COMPANY_A, {
          id: NEW_ID,
          path: `${COMPANY_A}/${A.attachment.replace(/-/g, '')}`,
        }),
      ),
    );
    expect(message).toMatch(/stored_path_key|unique/i);
  });

  it('refuses an empty file, a malformed checksum and a blank name', async () => {
    for (const [overrides, constraint] of [
      [{ size: 0 }, /size_positive/],
      [{ checksum: 'XYZ'.padEnd(64, '0') }, /checksum_sha256/],
      [{ name: '   ' }, /original_name_not_blank/],
    ] as const) {
      const message = await expectRejection(() =>
        asApp(COMPANY_A, insertAttachment(COMPANY_A, { id: NEW_ID, ...overrides })),
      );
      expect(message).toMatch(constraint);
    }
  });
});

describe('attachments — soft delete only (DOCUMENT 08 §4.14)', () => {
  it('the application role has no DELETE', async () => {
    const message = await expectRejection(() => asApp(COMPANY_A, 'DELETE FROM attachments'));
    expect(message).toMatch(/permission denied/i);
  });

  it('a soft delete is an UPDATE the role may make', async () => {
    await asApp(
      COMPANY_A,
      `UPDATE attachments SET deleted_at = now() WHERE id = '${A.attachment}'`,
    );
    const rows = await asApp<{ deleted_at: string | null }>(
      COMPANY_A,
      'SELECT deleted_at FROM attachments',
    );
    expect(rows[0]?.deleted_at).not.toBeNull();
  });
});

describe('attachment audit actions — DOCUMENT 21', () => {
  it('exist in audit_action', async () => {
    const rows = await asApp<{ label: string }>(
      COMPANY_A,
      `SELECT unnest(enum_range(NULL::audit_action))::text AS label`,
    );
    const labels = rows.map((row) => row.label);
    for (const action of ['attachment.uploaded', 'attachment.deleted', 'attachment.accessed']) {
      expect(labels).toContain(action);
    }
  });
});
