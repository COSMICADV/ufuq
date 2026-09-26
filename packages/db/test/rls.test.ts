/**
 * Row-level security — AD-03, DOCUMENT 09 §7, DOCUMENT 20 §3.
 *
 * This runs the real migration.sql (not a paraphrase of it) against a real
 * PostgreSQL engine — `@electric-sql/pglite` is Postgres itself compiled to
 * WASM, not a mock — and proves the policies hold with **no `WHERE`
 * clause at all** on the application side. That is the Phase 3 exit
 * criterion from DOCUMENT 25: "the tenancy scope cannot be bypassed by
 * omitting a where clause."
 *
 * One `PGlite` instance per test (not shared), queried directly — no network
 * socket. `SET ROLE` / `RESET ROLE` and `SET LOCAL` inside an explicit
 * transaction stand in for what `@ufuq/db`'s `withTenant` does through
 * PrismaClient; `test/tenant-client.test.ts` proves that helper does the
 * same thing through a real Prisma connection.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      '../prisma/migrations/20260101000000_phase3_auth_and_tenancy/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
);

const COMPANY_A = '00000000-0000-7000-8000-000000000001';
const COMPANY_B = '00000000-0000-7000-8000-000000000002';
const ROLE_ADMIN = '00000000-0000-7000-8000-0000000000a1';
const USER_A = '00000000-0000-7000-8000-000000000101';
const USER_B = '00000000-0000-7000-8000-000000000102';

let db: PGlite;

async function asOwner(sql: string): Promise<void> {
  await db.exec(sql);
}

beforeEach(async () => {
  db = new PGlite();
  await asOwner(MIGRATION_SQL);

  // Seed two tenants as the owner role, exactly as a real seed script would:
  // set the tenant context to the row's own id before writing it.
  await asOwner(`
    SELECT set_config('app.company_id', '${COMPANY_A}', false);
    INSERT INTO companies (id, name, slug, timezone, created_at, updated_at)
    VALUES ('${COMPANY_A}', 'Company A', 'company-a', 'Africa/Cairo', now(), now());
  `);
  await asOwner(`
    SELECT set_config('app.company_id', '${COMPANY_B}', false);
    INSERT INTO companies (id, name, slug, timezone, created_at, updated_at)
    VALUES ('${COMPANY_B}', 'Company B', 'company-b', 'Africa/Cairo', now(), now());
  `);
  await asOwner(`
    SELECT set_config('app.company_id', '', false);
    INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, created_at, updated_at)
    VALUES ('${ROLE_ADMIN}', NULL, 'admin', 'Admin', 'مدير الشركة', true, now(), now());
  `);
  await asOwner(`
    SELECT set_config('app.company_id', '${COMPANY_A}', false);
    INSERT INTO users (id, company_id, email, password_hash, role_id, status, created_at, updated_at)
    VALUES ('${USER_A}', '${COMPANY_A}', 'a@a.com', 'hash', '${ROLE_ADMIN}', 'active', now(), now());
  `);
  await asOwner(`
    SELECT set_config('app.company_id', '${COMPANY_B}', false);
    INSERT INTO users (id, company_id, email, password_hash, role_id, status, created_at, updated_at)
    VALUES ('${USER_B}', '${COMPANY_B}', 'b@b.com', 'hash', '${ROLE_ADMIN}', 'active', now(), now());
  `);

  // From here on, act as the restricted runtime role, the way the API does.
  await asOwner(`SET ROLE ufuq_app;`);
});

afterEach(async () => {
  await db.close();
});

describe('row-level security — the runtime role, no WHERE clause', () => {
  it('a query with no tenant filter still only returns the current company', async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_A}', false);`);
    const res = await db.query<{ id: string; email: string }>(`SELECT id, email FROM users`);
    expect(res.rows).toEqual([{ id: USER_A, email: 'a@a.com' }]);
  });

  it('switching the session variable switches which tenant is visible', async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_B}', false);`);
    const res = await db.query<{ email: string }>(`SELECT email FROM users`);
    expect(res.rows).toEqual([{ email: 'b@b.com' }]);
  });

  it('an empty tenant context returns nothing at all, not everything', async () => {
    await db.exec(`SELECT set_config('app.company_id', '', false);`);
    const res = await db.query(`SELECT id FROM users`);
    expect(res.rows).toEqual([]);
  });

  it('a system role (company_id NULL) is visible under any tenant context', async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_A}', false);`);
    const res = await db.query<{ key: string }>(`SELECT key FROM roles`);
    expect(res.rows).toEqual([{ key: 'admin' }]);
  });

  it('rejects an INSERT that names another company, even with app-role privileges', async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_A}', false);`);
    await expect(
      db.query(
        `INSERT INTO users (id, company_id, email, password_hash, role_id, status, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-000000000199', '${COMPANY_B}', 'evil@x.com', 'hash', '${ROLE_ADMIN}', 'active', now(), now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('rejects a cross-tenant UPDATE that would move a row into scope then out again', async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_A}', false);`);
    // Company A cannot even see company B's row to update it in the first
    // place — the UPDATE simply matches zero rows.
    const res = await db.query(`UPDATE users SET email = 'x' WHERE id = '${USER_B}'`);
    expect(res.affectedRows).toBe(0);
  });

  it('sets FORCE ROW LEVEL SECURITY on every tenant-scoped table', async () => {
    // Real PostgreSQL exempts *superusers* from row security even with
    // FORCE — that exemption cannot be revoked, by design, and is why the
    // application never authenticates as one (the two tests above are what
    // actually proves isolation: `ufuq_app`, the only role request-handling
    // code ever connects as, sees and writes exactly one tenant, with no
    // `WHERE` clause anywhere in sight). FORCE's job is to bind everyone who
    // *isn't* a superuser — a future non-superuser owner, or any script
    // someone points at this database later — to `app.company_id` the same
    // way `ufuq_app` already is. What this test can check from here is that
    // the flag itself is set, on every table row-level security should
    // cover.
    await db.exec(`RESET ROLE;`); // back to the owner
    const res = await db.query<{ relname: string }>(`
      SELECT relname FROM pg_class
      WHERE relrowsecurity AND relforcerowsecurity
        AND relname IN ('companies', 'roles', 'users', 'sessions', 'password_reset_tokens', 'invitations', 'audit_logs')
      ORDER BY relname
    `);
    expect(res.rows.map((r) => r.relname)).toEqual([
      'audit_logs',
      'companies',
      'invitations',
      'password_reset_tokens',
      'roles',
      'sessions',
      'users',
    ]);
  });
});

describe('audit_logs — append-only at the grant level (DOCUMENT 21)', () => {
  const AUDIT_ID = '00000000-0000-7000-8000-000000000201';

  beforeEach(async () => {
    await db.exec(`SELECT set_config('app.company_id', '${COMPANY_A}', false);`);
    await db.query(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity_type, entity_id, created_at)
       VALUES ('${AUDIT_ID}', '${COMPANY_A}', '${USER_A}', 'login.success', 'user', '${USER_A}', now())`,
    );
  });

  it('permits INSERT', async () => {
    const res = await db.query(`SELECT id FROM audit_logs WHERE id = '${AUDIT_ID}'`);
    expect(res.rows).toHaveLength(1);
  });

  it('denies UPDATE to the application role', async () => {
    await expect(
      db.query(`UPDATE audit_logs SET entity_type = 'tampered' WHERE id = '${AUDIT_ID}'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies DELETE to the application role', async () => {
    await expect(db.query(`DELETE FROM audit_logs WHERE id = '${AUDIT_ID}'`)).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe('auth_lookup_* SECURITY DEFINER functions — the one sanctioned bypass', () => {
  it('resolves a user by email across tenants with no context set', async () => {
    await db.exec(`SELECT set_config('app.company_id', '', false);`);
    const res = await db.query<{ company_id: string; email: string }>(
      `SELECT company_id, email FROM auth_lookup_login('b@b.com')`,
    );
    expect(res.rows).toEqual([{ company_id: COMPANY_B, email: 'b@b.com' }]);
  });

  it('returns nothing for an unknown email, not an error', async () => {
    await db.exec(`SELECT set_config('app.company_id', '', false);`);
    const res = await db.query(`SELECT * FROM auth_lookup_login('nobody@nowhere.com')`);
    expect(res.rows).toEqual([]);
  });

  it('does not let the application role query the underlying table directly without context', async () => {
    await db.exec(`SELECT set_config('app.company_id', '', false);`);
    const res = await db.query(`SELECT * FROM users WHERE email = 'b@b.com'`);
    expect(res.rows).toEqual([]);
  });
});
