/**
 * The five `auth_lookup_*` SECURITY DEFINER functions cannot be steered by a
 * session's temporary tables — migration
 * `20260928000000_auth_lookup_search_path`.
 *
 * These functions run as their owner, outside row-level security, and they
 * are what login, forgot-password, session resolution, mobile refresh,
 * password reset and invitation acceptance start from. PostgreSQL searches
 * `pg_temp` before every schema in `search_path` unless it is named, and
 * `ufuq_app` may create temporary tables — so with `SET search_path = public`
 * a session could plant a temporary `users` (or `sessions`, …) table and have
 * the function read it instead of the real one.
 *
 * Proved both ways, so the test cannot pass by accident:
 *
 *   - against every migration **before** the fix, a temporary table does
 *     change what the functions return — the weakness was real;
 *   - against every migration **including** the fix, the same temporary
 *     tables change nothing, the setting is pinned, and PUBLIC still cannot
 *     execute any of them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const FIX = '20260928000000_auth_lookup_search_path';

function migrationsSql(options: { readonly includeFix: boolean }): string {
  return readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) => options.includeFix || name < FIX)
    .map((name) => readFileSync(`${MIGRATIONS_DIRECTORY}${name}/migration.sql`, 'utf8'))
    .join('\n');
}

const COMPANY = '00000000-0000-7000-8000-000000000001';
const ROLE = '00000000-0000-7000-8000-0000000000a0';
const USER = '00000000-0000-7000-8000-000000000101';
const SESSION = '00000000-0000-7000-8000-000000000201';
const RESET = '00000000-0000-7000-8000-000000000301';
const INVITATION = '00000000-0000-7000-8000-000000000401';

/** Rows a planted temporary table would try to substitute. */
const FAKE_COMPANY = '00000000-0000-7000-8000-00000000dead';
const FAKE_ID = '00000000-0000-7000-8000-00000000beef';

const EMAIL = 'person@company.test';
const TOKEN = 'a'.repeat(64);
const REFRESH = 'b'.repeat(64);
const RESET_TOKEN = 'c'.repeat(64);
const INVITE_TOKEN = 'd'.repeat(64);

/** Each lookup, as the application calls it. */
const LOOKUPS = {
  auth_lookup_login: `SELECT * FROM auth_lookup_login('${EMAIL}')`,
  auth_lookup_session: `SELECT * FROM auth_lookup_session('${TOKEN}')`,
  auth_lookup_session_by_refresh_hash: `SELECT * FROM auth_lookup_session_by_refresh_hash('${REFRESH}')`,
  auth_lookup_reset_token: `SELECT * FROM auth_lookup_reset_token('${RESET_TOKEN}')`,
  auth_lookup_invitation_token: `SELECT * FROM auth_lookup_invitation_token('${INVITE_TOKEN}')`,
} as const;

type LookupName = keyof typeof LOOKUPS;
const NAMES = Object.keys(LOOKUPS) as LookupName[];

let db: PGlite | null = null;

async function boot(options: { readonly includeFix: boolean }): Promise<PGlite> {
  const pg = new PGlite();
  db = pg;
  await pg.exec(migrationsSql(options));
  // Seeded as the owner, one real row behind every lookup.
  await pg.exec(`
    SELECT set_config('app.company_id', '${COMPANY}', false);
    INSERT INTO roles (id, company_id, key, name_en, name_ar, is_system, updated_at)
      VALUES ('${ROLE}', NULL, 'admin', 'Admin', 'مدير', true, now());
    INSERT INTO companies (id, name, slug, timezone, updated_at)
      VALUES ('${COMPANY}', 'Company', 'company', 'Africa/Cairo', now());
    INSERT INTO users (id, company_id, email, password_hash, role_id, status, updated_at)
      VALUES ('${USER}', '${COMPANY}', '${EMAIL}', 'real-hash', '${ROLE}', 'active', now());
    INSERT INTO sessions (id, company_id, user_id, client_type, token_hash, refresh_token_hash, expires_at)
      VALUES ('${SESSION}', '${COMPANY}', '${USER}', 'mobile', '${TOKEN}', '${REFRESH}', now() + interval '1 day');
    INSERT INTO password_reset_tokens (id, company_id, user_id, token_hash, expires_at)
      VALUES ('${RESET}', '${COMPANY}', '${USER}', '${RESET_TOKEN}', now() + interval '1 hour');
    INSERT INTO invitations (id, company_id, user_id, token_hash, expires_at)
      VALUES ('${INVITATION}', '${COMPANY}', '${USER}', '${INVITE_TOKEN}', now() + interval '1 day');
    SELECT set_config('app.company_id', '', false);
  `);
  // From here on, the restricted application role with no tenant bound —
  // exactly the context the API calls these functions from.
  await pg.exec('SET ROLE ufuq_app;');
  return pg;
}

async function lookup(pg: PGlite, name: LookupName): Promise<unknown[]> {
  return (await pg.query(LOOKUPS[name])).rows;
}

/**
 * Temporary tables shaped exactly like the real ones (`LIKE`), each holding a
 * row that answers the same lookup key with a different identity.
 */
async function plantShadows(pg: PGlite): Promise<void> {
  await pg.exec(`
    CREATE TEMP TABLE companies (LIKE public.companies INCLUDING DEFAULTS);
    INSERT INTO pg_temp.companies (id, name, slug, timezone, status, updated_at)
      VALUES ('${FAKE_COMPANY}', 'Fake', 'fake', 'UTC', 'active', now());
    CREATE TEMP TABLE users (LIKE public.users INCLUDING DEFAULTS);
    INSERT INTO pg_temp.users (id, company_id, email, password_hash, role_id, status, updated_at)
      VALUES ('${FAKE_ID}', '${FAKE_COMPANY}', '${EMAIL}', 'attacker-hash', '${ROLE}', 'active', now());
    CREATE TEMP TABLE sessions (LIKE public.sessions INCLUDING DEFAULTS);
    INSERT INTO pg_temp.sessions (id, company_id, user_id, client_type, token_hash, refresh_token_hash, expires_at)
      VALUES ('${FAKE_ID}', '${FAKE_COMPANY}', '${FAKE_ID}', 'web', '${TOKEN}', '${REFRESH}', now() + interval '1 year');
    CREATE TEMP TABLE password_reset_tokens (LIKE public.password_reset_tokens INCLUDING DEFAULTS);
    INSERT INTO pg_temp.password_reset_tokens (id, company_id, user_id, token_hash, expires_at)
      VALUES ('${FAKE_ID}', '${FAKE_COMPANY}', '${FAKE_ID}', '${RESET_TOKEN}', now() + interval '1 year');
    CREATE TEMP TABLE invitations (LIKE public.invitations INCLUDING DEFAULTS);
    INSERT INTO pg_temp.invitations (id, company_id, user_id, token_hash, expires_at)
      VALUES ('${FAKE_ID}', '${FAKE_COMPANY}', '${FAKE_ID}', '${INVITE_TOKEN}', now() + interval '1 year');
  `);
}

afterEach(async () => {
  await db?.close();
  db = null;
});

describe('before the fix — the weakness was real', () => {
  it('a planted temporary table changes what every auth lookup returns', async () => {
    const pg = await boot({ includeFix: false });
    const before = Object.fromEntries(
      await Promise.all(NAMES.map(async (name) => [name, await lookup(pg, name)] as const)),
    );
    await plantShadows(pg);
    for (const name of NAMES) {
      const after = await lookup(pg, name);
      expect(after, name).not.toEqual(before[name]);
      expect(JSON.stringify(after), name).toContain(FAKE_ID.slice(-4));
    }
  });
});

describe('after the fix — 20260928000000_auth_lookup_search_path', () => {
  it('every lookup still finds its real row', async () => {
    const pg = await boot({ includeFix: true });
    expect(await lookup(pg, 'auth_lookup_login')).toMatchObject([
      { id: USER, company_id: COMPANY, email: EMAIL, password_hash: 'real-hash' },
    ]);
    expect(await lookup(pg, 'auth_lookup_session')).toMatchObject([{ id: SESSION, user_id: USER }]);
    expect(await lookup(pg, 'auth_lookup_session_by_refresh_hash')).toMatchObject([
      { id: SESSION, user_id: USER },
    ]);
    expect(await lookup(pg, 'auth_lookup_reset_token')).toMatchObject([
      { id: RESET, user_id: USER },
    ]);
    expect(await lookup(pg, 'auth_lookup_invitation_token')).toMatchObject([
      { id: INVITATION, user_id: USER },
    ]);
  });

  it('temporary tables named like the real ones change nothing', async () => {
    const pg = await boot({ includeFix: true });
    const before = Object.fromEntries(
      await Promise.all(NAMES.map(async (name) => [name, await lookup(pg, name)] as const)),
    );
    await plantShadows(pg);
    for (const name of NAMES) {
      expect(await lookup(pg, name), name).toEqual(before[name]);
    }
  });

  it('keeps hiding the system actor from login and forgot-password', async () => {
    const pg = await boot({ includeFix: true });
    await pg.exec(`RESET ROLE;
      SELECT set_config('app.company_id', '${COMPANY}', false);
      INSERT INTO users (id, company_id, email, role_id, status, is_system, updated_at)
        VALUES ('${FAKE_ID}', '${COMPANY}', 'system@ufuq.invalid', '${ROLE}', 'deactivated', true, now());
      SELECT set_config('app.company_id', '', false);
      SET ROLE ufuq_app;`);
    expect((await pg.query(`SELECT * FROM auth_lookup_login('system@ufuq.invalid')`)).rows).toEqual(
      [],
    );
  });

  it('pins every search_path, keeps every function SECURITY DEFINER', async () => {
    const pg = await boot({ includeFix: true });
    const rows = (
      await pg.query<{ proname: string; proconfig: string[]; prosecdef: boolean }>(
        `SELECT proname, proconfig, prosecdef FROM pg_proc
         WHERE proname LIKE 'auth\\_lookup\\_%' ORDER BY proname`,
      )
    ).rows;
    expect(rows.map((row) => row.proname).sort()).toEqual([...NAMES].sort());
    for (const row of rows) {
      expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, public, pg_temp']);
      expect(row.prosecdef, row.proname).toBe(true);
    }
  });

  it('grants EXECUTE to ufuq_app and never to PUBLIC', async () => {
    const pg = await boot({ includeFix: true });
    for (const name of NAMES) {
      const rows = (
        await pg.query<{ app: boolean; pub: boolean }>(
          `SELECT has_function_privilege('ufuq_app', '${name}(text)', 'EXECUTE') AS app,
                  has_function_privilege('public', '${name}(text)', 'EXECUTE') AS pub`,
        )
      ).rows;
      expect(rows[0], name).toEqual({ app: true, pub: false });
    }
  });

  it('leaves row-level security as it was: no tenant bound, no rows visible directly', async () => {
    const pg = await boot({ includeFix: true });
    for (const table of [
      'users',
      'sessions',
      'password_reset_tokens',
      'invitations',
      'companies',
    ]) {
      expect((await pg.query(`SELECT 1 FROM public.${table}`)).rows, table).toEqual([]);
    }
  });
});
