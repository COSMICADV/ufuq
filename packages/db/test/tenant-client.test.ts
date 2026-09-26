/**
 * `withTenant` / `withPlatformContext` through a real `PrismaClient` — proves
 * the helper in `src/tenant.ts`, not just the SQL it relies on
 * (`test/rls.test.ts` covers the SQL directly).
 *
 * A `PGLiteSocketServer` gives Prisma's real query engine a real
 * PostgreSQL-wire-protocol connection to a real (WASM) Postgres — this is
 * the same client code path production runs, pointed at a different
 * database. `connection_limit=1` pins Prisma to one physical connection so
 * `SET LOCAL` behaves the same way it does against a normal pooled
 * connection: scoped to one transaction, never leaking into the next.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { lookupSessionByTokenHash, lookupUsersByEmail } from '../src/auth-lookups.js';
import { createPrismaClient } from '../src/client.js';
import { generateId } from '../src/id.js';
import { withPlatformContext, withTenant } from '../src/tenant.js';
import type { PrismaClient } from '@prisma/client';

/**
 * **Every** migration, in application order.
 *
 * This suite drives the generated Prisma client rather than raw SQL, and the
 * client always describes the whole schema — so a suite that applied only its
 * own phase's migration would be testing a database no deployment has, and
 * would break the first time any later phase added a column. Reading the
 * directory means a new migration is picked up without anyone remembering to
 * add it here. (The `*-rls.test.ts` suites list migrations explicitly on
 * purpose: they use raw SQL to assert what a specific migration created.)
 */
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));

const MIGRATION_SQL = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  // Prisma's directory names start with a UTC timestamp, so name order is
  // application order.
  .sort((a, b) => a.name.localeCompare(b.name))
  .map((entry) =>
    readFileSync(
      fileURLToPath(new URL(`${entry.name}/migration.sql`, `file://${MIGRATIONS_DIRECTORY}`)),
      'utf8',
    ),
  )
  .join('\n');

let pglite: PGlite;
let socket: PGLiteSocketServer;
let prisma: PrismaClient;

const COMPANY_A = generateId();
const COMPANY_B = generateId();
const ROLE_ADMIN = generateId();

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.exec(MIGRATION_SQL);

  socket = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
  await socket.start();
  const port = socket.port;

  // Production connects directly as `ufuq_app` — no SET ROLE anywhere in
  // `withTenant`/`withPlatformContext`, and none is needed there, because a
  // real PostgreSQL server authenticates a connection as the role it was
  // asked to authenticate as. `pglite-socket`'s login handshake does not:
  // it accepts any role name in the startup packet without actually
  // switching the session's authorization, so a direct
  // `ufuq_app@…` connection string here would silently run as the
  // superuser and prove nothing about RLS. Connecting as the bootstrap
  // superuser and issuing one real `SET ROLE` — a genuine SQL-level
  // privilege switch the WASM query engine itself enforces, not an
  // artifact of the socket layer — reproduces a restricted session
  // faithfully. `connection_limit=1` pins Prisma to that one physical
  // connection for the test file's lifetime, so the switch, made once
  // below, is never lost to a different pooled connection.
  prisma = createPrismaClient(
    `postgresql://postgres@127.0.0.1:${port}/postgres?connection_limit=1`,
  );
  await prisma.$executeRawUnsafe('SET ROLE ufuq_app');

  await withTenant(prisma, COMPANY_A, async (tx) => {
    await tx.company.create({
      data: { id: COMPANY_A, name: 'Company A', slug: 'company-a', timezone: 'Africa/Cairo' },
    });
  });
  await withTenant(prisma, COMPANY_B, async (tx) => {
    await tx.company.create({
      data: { id: COMPANY_B, name: 'Company B', slug: 'company-b', timezone: 'Africa/Cairo' },
    });
  });
  await withPlatformContext(prisma, async (tx) => {
    await tx.role.create({
      data: {
        id: ROLE_ADMIN,
        companyId: null,
        key: 'admin',
        nameEn: 'Admin',
        nameAr: 'مدير الشركة',
        isSystem: true,
      },
    });
  });
  await withTenant(prisma, COMPANY_A, async (tx) => {
    await tx.user.create({
      data: {
        id: generateId(),
        companyId: COMPANY_A,
        email: 'a@a.com',
        passwordHash: 'hash',
        roleId: ROLE_ADMIN,
        status: 'active',
      },
    });
  });
  await withTenant(prisma, COMPANY_B, async (tx) => {
    await tx.user.create({
      data: {
        id: generateId(),
        companyId: COMPANY_B,
        email: 'b@b.com',
        passwordHash: 'hash',
        roleId: ROLE_ADMIN,
        status: 'active',
      },
    });
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  await socket.stop();
  await pglite.close();
});

describe('withTenant — real PrismaClient, real RLS', () => {
  it('finds only the bound tenant’s rows via a plain findMany with no company filter', async () => {
    const users = await withTenant(prisma, COMPANY_A, (tx) => tx.user.findMany());
    expect(users.map((u) => u.email)).toEqual(['a@a.com']);
  });

  it('switching companyId between calls switches the visible tenant', async () => {
    const usersB = await withTenant(prisma, COMPANY_B, (tx) => tx.user.findMany());
    expect(usersB.map((u) => u.email)).toEqual(['b@b.com']);
  });

  it('refuses to create a row for a different company than the bound tenant', async () => {
    await expect(
      withTenant(prisma, COMPANY_A, (tx) =>
        tx.user.create({
          data: {
            id: generateId(),
            companyId: COMPANY_B,
            email: 'evil@x.com',
            passwordHash: 'hash',
            roleId: ROLE_ADMIN,
            status: 'active',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('does not leak tenant context from one call into the next (SET LOCAL, not SET)', async () => {
    await withTenant(prisma, COMPANY_A, (tx) => tx.user.findMany());
    // A call with no withTenant/withPlatformContext wrapper at all must see
    // nothing — proving the previous call's context did not survive.
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::int AS n FROM users`;
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('withPlatformContext + auth-lookups — the pre-tenant-context path', () => {
  it('lookupUsersByEmail resolves a user with no tenant bound', async () => {
    const rows = await withPlatformContext(prisma, (tx) => lookupUsersByEmail(tx, 'b@b.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.companyId).toBe(COMPANY_B);
  });

  it('lookupSessionByTokenHash returns null for an unknown token, not an error', async () => {
    const row = await withPlatformContext(prisma, (tx) =>
      lookupSessionByTokenHash(tx, 'no-such-hash'),
    );
    expect(row).toBeNull();
  });

  it('an ordinary tenant-scoped query returns nothing under the platform context', async () => {
    const users = await withPlatformContext(prisma, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });
});
