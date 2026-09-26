/**
 * Tenant context binding — AD-03, DOCUMENT 09 §7, DOCUMENT 20 §3.
 *
 * PostgreSQL row-level security (see the Phase 3 migration) reads the tenant
 * id from the `app.company_id` session variable. This module is the *only*
 * place that variable is ever set — every tenant-scoped query in the
 * application reaches the database through {@link withTenant}, and every
 * pre-authentication lookup reaches it through {@link withPlatformContext}.
 * A caller that reaches for `prisma.$transaction` directly instead of these
 * two functions has stepped around the tenant scope; that is exactly the
 * "forgotten `where company_id`" DOCUMENT 27 RULE 10 exists to make
 * impossible, so there is no third way to reach the database here.
 *
 * `set_config(..., true)` is `SET LOCAL`, not `SET` — the value lives only
 * for the current transaction and cannot leak onto a pooled connection that
 * is reused by a later, unrelated request.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

export type TenantClient = Prisma.TransactionClient;

const COMPANY_CONTEXT_SETTING = 'app.company_id';

/**
 * Run `fn` inside a transaction whose queries are restricted by row-level
 * security to `companyId`. This is how every authenticated, tenant-bound
 * request must touch the database.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  companyId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${COMPANY_CONTEXT_SETTING}, ${companyId}, true)`;
    return fn(tx);
  });
}

/**
 * Run `fn` inside a transaction with no tenant bound at all. Row-level
 * security then denies every ordinary table read and write; only the
 * `auth_lookup_*` SECURITY DEFINER functions (login, session, password
 * reset, invitation — see the Phase 3 migration) work here, because
 * resolving *which* tenant a bare credential belongs to is what those calls
 * are for — plus `platform_list_active_company_ids` (`platform-lookups.ts`),
 * which tells a platform-level job which tenants to visit. Nothing else
 * should run inside this context.
 */
export async function withPlatformContext<T>(
  prisma: PrismaClient,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config(${COMPANY_CONTEXT_SETTING}, '', true)`;
    return fn(tx);
  });
}
