/**
 * Typed wrapper around `platform_list_active_company_ids`, the SECURITY
 * DEFINER function defined in the Phase 6 critical-fix migration.
 *
 * Background work that runs for every company — the nightly attendance run
 * first — starts with no tenant bound, and row-level security answers "which
 * companies are there?" with nothing (see `tenant.ts`). This is the one
 * sanctioned way to ask it: an explicit, greppable call (DOCUMENT 09 §7) that
 * returns ids and nothing else. Whatever the caller then needs about a company
 * it reads inside that company's own {@link withTenant} scope.
 *
 * Call it inside {@link withPlatformContext}; it is for platform-level jobs,
 * never for request handling.
 */

import type { TenantClient } from './tenant.js';

/** Active, non-deleted companies, in id order. */
export async function listActiveCompanyIds(tx: TenantClient): Promise<readonly string[]> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM platform_list_active_company_ids()`;
  return rows.map((row) => row.id);
}
