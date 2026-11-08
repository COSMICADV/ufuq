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

/** One public sign-up, as the platform owner's review page shows it. */
export interface SignupRequestRow {
  readonly companyId: string;
  readonly companyName: string;
  readonly employeeCountRange: string | null;
  readonly status: 'pending_approval' | 'active' | 'rejected';
  readonly createdAt: Date;
  readonly reviewedAt: Date | null;
  readonly adminName: string | null;
  readonly adminEmail: string;
  readonly adminPhone: string | null;
}

/**
 * Wrapper around `platform_list_signup_requests` (the sign-up approval
 * migration): pending sign-ups first, then ones already reviewed. Call it
 * inside {@link withPlatformContext}, and only behind the owner key check.
 */
export async function listSignupRequests(tx: TenantClient): Promise<readonly SignupRequestRow[]> {
  const rows = await tx.$queryRaw<
    {
      company_id: string;
      company_name: string;
      employee_count_range: string | null;
      status: string;
      created_at: Date;
      reviewed_at: Date | null;
      admin_name: string | null;
      admin_email: string;
      admin_phone: string | null;
    }[]
  >`SELECT * FROM platform_list_signup_requests()`;
  return rows.map((r) => ({
    companyId: r.company_id,
    companyName: r.company_name,
    employeeCountRange: r.employee_count_range,
    status: r.status as SignupRequestRow['status'],
    createdAt: r.created_at,
    reviewedAt: r.reviewed_at,
    adminName: r.admin_name,
    adminEmail: r.admin_email,
    adminPhone: r.admin_phone,
  }));
}
