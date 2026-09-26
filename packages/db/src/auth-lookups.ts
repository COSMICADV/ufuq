/**
 * Typed wrappers around the `auth_lookup_*` SECURITY DEFINER functions
 * defined in the Phase 3 migration (see `tenant.ts` for why they exist and
 * why they are the only sanctioned way to query before a tenant is known).
 *
 * These are the single place the raw function names and their column shapes
 * are known outside SQL — every caller in `apps/api` goes through here
 * instead of writing `$queryRaw` against `auth_lookup_login` itself, so a
 * change to a function's return shape has exactly one call site to update.
 */

import type { TenantClient } from './tenant.js';

export interface AuthLoginLookupRow {
  readonly id: string;
  readonly companyId: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly roleId: string;
  readonly status: 'invited' | 'active' | 'deactivated';
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly companyStatus: 'active' | 'suspended' | 'cancelled';
}

interface RawLoginRow {
  id: string;
  company_id: string;
  email: string;
  password_hash: string | null;
  role_id: string;
  status: string;
  failed_login_count: number;
  last_failed_login_at: Date | null;
  locked_until: Date | null;
  company_status: string;
}

/**
 * DOCUMENT 09 §1 step 2. May return more than one row: `email` is unique per
 * company, not globally (DOCUMENT 06 §3.2), so the same address can name a
 * user in two different companies. The caller decides what that means.
 */
export async function lookupUsersByEmail(
  tx: TenantClient,
  email: string,
): Promise<readonly AuthLoginLookupRow[]> {
  const rows = await tx.$queryRaw<RawLoginRow[]>`SELECT * FROM auth_lookup_login(${email})`;
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    email: r.email,
    passwordHash: r.password_hash,
    roleId: r.role_id,
    status: r.status as AuthLoginLookupRow['status'],
    failedLoginCount: r.failed_login_count,
    lastFailedLoginAt: r.last_failed_login_at,
    lockedUntil: r.locked_until,
    companyStatus: r.company_status as AuthLoginLookupRow['companyStatus'],
  }));
}

export interface AuthSessionLookupRow {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly clientType: 'web' | 'mobile';
  readonly rememberMe: boolean;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface RawSessionRow {
  id: string;
  company_id: string;
  user_id: string;
  client_type: string;
  remember_me: boolean;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** DOCUMENT 09 §3 — resolves the caller's session before any tenant context exists. */
export async function lookupSessionByTokenHash(
  tx: TenantClient,
  tokenHash: string,
): Promise<AuthSessionLookupRow | null> {
  const rows = await tx.$queryRaw<RawSessionRow[]>`SELECT * FROM auth_lookup_session(${tokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    clientType: row.client_type as AuthSessionLookupRow['clientType'],
    rememberMe: row.remember_me,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export interface AuthResetTokenLookupRow {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

interface RawResetTokenRow {
  id: string;
  company_id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

/** DOCUMENT 08 §4.1 `POST /auth/reset-password`. */
export async function lookupPasswordResetTokenByHash(
  tx: TenantClient,
  tokenHash: string,
): Promise<AuthResetTokenLookupRow | null> {
  const rows = await tx.$queryRaw<
    RawResetTokenRow[]
  >`SELECT * FROM auth_lookup_reset_token(${tokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
  };
}

export interface AuthInvitationLookupRow {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
}

interface RawInvitationRow {
  id: string;
  company_id: string;
  user_id: string;
  expires_at: Date;
  accepted_at: Date | null;
}

/** DOCUMENT 08 §4.1 `POST /auth/accept-invitation`. */
export async function lookupInvitationByTokenHash(
  tx: TenantClient,
  tokenHash: string,
): Promise<AuthInvitationLookupRow | null> {
  const rows = await tx.$queryRaw<
    RawInvitationRow[]
  >`SELECT * FROM auth_lookup_invitation_token(${tokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
  };
}

export interface AuthRefreshSessionLookupRow {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
  readonly clientType: 'web' | 'mobile';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

interface RawRefreshSessionRow {
  id: string;
  company_id: string;
  user_id: string;
  client_type: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** DOCUMENT 09 §3 / OD-02 — `POST /auth/refresh` (mobile only). */
export async function lookupSessionByRefreshTokenHash(
  tx: TenantClient,
  refreshTokenHash: string,
): Promise<AuthRefreshSessionLookupRow | null> {
  const rows = await tx.$queryRaw<
    RawRefreshSessionRow[]
  >`SELECT * FROM auth_lookup_session_by_refresh_hash(${refreshTokenHash})`;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    clientType: row.client_type as AuthRefreshSessionLookupRow['clientType'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}
