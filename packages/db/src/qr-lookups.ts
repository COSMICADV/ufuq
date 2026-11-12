/**
 * Typed wrappers around the QR Studio SECURITY DEFINER functions (the QR Studio
 * migration). A scan arrives with no session, so the public scan page first
 * learns which company a short link or file belongs to here, inside
 * {@link withPlatformContext}, and then does everything else inside that
 * company's own {@link withTenant} scope.
 */

import type { TenantClient } from './tenant.js';

/** The code a short link names, or null when there is none (or its company is not active). */
export async function lookupQrCodeBySlug(
  tx: TenantClient,
  slug: string,
): Promise<{ readonly id: string; readonly companyId: string } | null> {
  const rows = await tx.$queryRaw<
    { id: string; company_id: string }[]
  >`SELECT id, company_id FROM qr_lookup_slug(${slug})`;
  const row = rows[0];
  return row === undefined ? null : { id: row.id, companyId: row.company_id };
}

/** The company holding an uploaded QR file, or null. */
export async function lookupQrFileCompany(tx: TenantClient, id: string): Promise<string | null> {
  const rows = await tx.$queryRaw<
    { company_id: string }[]
  >`SELECT company_id FROM qr_lookup_file(${id}::uuid)`;
  return rows[0]?.company_id ?? null;
}

/** Whether any company already uses this short link. */
export async function isQrSlugTaken(tx: TenantClient, slug: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ taken: boolean }[]>`SELECT qr_slug_taken(${slug}) AS taken`;
  return rows[0]?.taken === true;
}
