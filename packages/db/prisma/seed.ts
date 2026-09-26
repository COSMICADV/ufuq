/**
 * Phase 3 reference-data seed — DOCUMENT 02 §2, §4.
 *
 * Idempotent: every write is an upsert keyed on a natural key (a permission's
 * `key`, a role's `(companyId, key)`, a role/permission pair, a company's
 * `slug`, a user's `(companyId, email)`), so running this against a database
 * that already has the data updates it in place instead of duplicating it.
 *
 * Two things are seeded, and they are seeded differently:
 *
 * 1. The permission catalogue, the four system roles, and their grants —
 *    reference data DOCUMENT 02 §4 defines completely. This runs everywhere,
 *    production included; there is nothing environment-specific about it.
 * 2. A demo company and its first ADMIN user — this exists only because
 *    Phase 3 has no company-registration flow yet (DOCUMENT 25 Phase 16) and
 *    no employee-creation flow yet (Phase 5), so there is otherwise no way to
 *    obtain a first account to log in with and exercise this phase. It is
 *    skipped when `NODE_ENV=production`. See the Phase 3 report for why this
 *    exists and what replaces it once Phase 16 ships.
 */

import { hashPassword, PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from '@ufuq/auth';

import { generateId } from '../src/id.js';
import { createPrismaClient } from '../src/client.js';
import { withPlatformContext, withTenant } from '../src/tenant.js';

// Fixed rather than freshly generated: re-running this script has to bind
// the same tenant context to the same row every time. Row-level security
// (see `tenant.ts`) means a *generated* id cannot be used to look up a row
// that was created under a different one on a previous run — the lookup
// would come back empty and the upsert would collide with the unique slug
// instead of finding it. A fixed seed id sidesteps that; it is still a
// valid UUID, just not one OD-12's "generated per row" rule needs to cover
// for fixture data that is only ever this one row.
const DEMO_COMPANY_ID = '00000000-0000-7000-8000-000000000001';
const DEMO_COMPANY_SLUG = 'demo';
const DEMO_ADMIN_EMAIL = 'admin@demo.ufuq.local';
// Local/demo credential only — never a production secret (DOCUMENT 20 §11).
// Long enough and specific enough that it is not in the DOCUMENT 09 §2
// breach list this same package ships.
const DEMO_ADMIN_PASSWORD = 'ufuq-demo-admin-2026-local-only';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required to run the seed script.`);
  }
  return value;
}

async function seedPermissionsAndRoles(
  prisma: ReturnType<typeof createPrismaClient>,
): Promise<void> {
  await withPlatformContext(prisma, async (tx) => {
    const permissionIdByKey = new Map<string, string>();
    for (const permission of PERMISSIONS) {
      const row = await tx.permission.upsert({
        where: { key: permission.key },
        create: {
          id: generateId(),
          key: permission.key,
          module: permission.module,
          descriptionEn: permission.descriptionEn,
          descriptionAr: permission.descriptionAr,
        },
        update: {
          module: permission.module,
          descriptionEn: permission.descriptionEn,
          descriptionAr: permission.descriptionAr,
        },
      });
      permissionIdByKey.set(permission.key, row.id);
    }

    const roleIdByKey = new Map<string, string>();
    for (const role of SYSTEM_ROLES) {
      // Not `upsert`: Prisma's compound-unique shorthand
      // (`companyId_key: { companyId, key }`) does not accept `null` for a
      // nullable component, even though the column itself does and the hand-
      // written partial index (migration.sql) is exactly what makes `null`
      // meaningful here — "the" system role for this key.
      const existing = await tx.role.findFirst({ where: { companyId: null, key: role.key } });
      const row = existing
        ? await tx.role.update({
            where: { id: existing.id },
            data: { nameEn: role.nameEn, nameAr: role.nameAr, isSystem: true },
          })
        : await tx.role.create({
            data: {
              id: generateId(),
              companyId: null,
              key: role.key,
              nameEn: role.nameEn,
              nameAr: role.nameAr,
              isSystem: true,
            },
          });
      roleIdByKey.set(role.key, row.id);
    }

    for (const grant of ROLE_PERMISSIONS) {
      const roleId = roleIdByKey.get(grant.role);
      const permissionId = permissionIdByKey.get(grant.permission);
      if (!roleId || !permissionId) {
        // Cannot happen — both maps are built from the same @ufuq/auth
        // catalogue this loop iterates — but a silently skipped grant would
        // be a worse failure mode than a loud one.
        throw new Error(`Unresolved grant: ${grant.role} → ${grant.permission}`);
      }
      await tx.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId, scope: grant.scope },
        update: { scope: grant.scope },
      });
    }

    console.log(
      `Seeded ${permissionIdByKey.size} permissions, ${roleIdByKey.size} system roles, ${ROLE_PERMISSIONS.length} grants.`,
    );
  });
}

async function seedDemoCompany(prisma: ReturnType<typeof createPrismaClient>): Promise<void> {
  await withTenant(prisma, DEMO_COMPANY_ID, async (tx) => {
    const company = await tx.company.upsert({
      where: { id: DEMO_COMPANY_ID },
      create: {
        id: DEMO_COMPANY_ID,
        name: 'Demo Company',
        slug: DEMO_COMPANY_SLUG,
        timezone: 'Africa/Cairo',
        currency: 'EGP',
        defaultLocale: 'ar',
      },
      update: {},
    });

    const adminRole = await tx.role.findFirstOrThrow({ where: { companyId: null, key: 'admin' } });

    const passwordHash = await hashPassword(DEMO_ADMIN_PASSWORD);
    await tx.user.upsert({
      where: { companyId_email: { companyId: company.id, email: DEMO_ADMIN_EMAIL } },
      create: {
        id: generateId(),
        companyId: company.id,
        email: DEMO_ADMIN_EMAIL,
        passwordHash,
        roleId: adminRole.id,
        status: 'active',
        emailVerifiedAt: new Date(),
      },
      update: {},
    });

    console.log(
      `Seeded demo company "${company.slug}" (${company.id}) with admin ${DEMO_ADMIN_EMAIL}.`,
    );
  });
}

// Local dev/CI only, mirroring `docker-compose.yml`'s own `ufuq_local_password`
// for the bootstrap superuser — never a production secret (DOCUMENT 20 §11).
// The Phase 3 migration creates the `ufuq_app` role without a password (a
// migration file is version-controlled and runs in every environment, so it
// cannot contain one); something has to set one for local Postgres to accept
// `DATABASE_URL` connections at all, and this script already runs with the
// migration role's privileges every time a developer sets up the database.
const LOCAL_APP_ROLE_PASSWORD = 'ufuq_app_local_password';

async function ensureLocalAppRolePassword(
  prisma: ReturnType<typeof createPrismaClient>,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER ROLE "ufuq_app" WITH LOGIN PASSWORD '${LOCAL_APP_ROLE_PASSWORD}'`,
  );
  console.log('Set the local-only ufuq_app role password (see prisma/seed.ts for why).');
}

async function main(): Promise<void> {
  // The owner/migration role, not `DATABASE_URL` (`ufuq_app`): seeding
  // `permissions` and `role_permissions` is an operator action akin to a
  // migration (DOCUMENT 02 §2 — "adding a role is a data insert"), not
  // something request-handling code ever does, and the Phase 3 migration
  // grants `ufuq_app` read-only access to those two tables precisely
  // because nothing in the running application should ever write to them.
  const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? requireEnv('DATABASE_URL');
  const prisma = createPrismaClient(databaseUrl);

  try {
    if (process.env.NODE_ENV === 'production') {
      console.log(
        'NODE_ENV=production — skipping demo company, admin user, and local role password.',
      );
      await seedPermissionsAndRoles(prisma);
    } else {
      await ensureLocalAppRolePassword(prisma);
      await seedPermissionsAndRoles(prisma);
      await seedDemoCompany(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
