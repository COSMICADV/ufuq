/**
 * Who the caller is in the restaurant — the owner, or one employee with one
 * role in one branch — asked first by every restaurant route. Branch
 * isolation is enforced here: a staff member's branch is decided by their
 * restaurant record, never by what the request names.
 */

import type { TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { fieldError, notFound } from '../company-structure/tenant-scoped.service.js';

import { ACTIONS, OWNER_ROLES, RESTAURANT_ACTIVITY, roleAllows } from './restaurant-rules.js';
import type { RestaurantAction, RestaurantRoleKey } from './restaurant-rules.js';

export interface RestaurantAccess {
  readonly enabled: boolean;
  readonly owner: boolean;
  readonly employeeId: string | null;
  /** Null for the owner, and for an employee who is not on the restaurant team. */
  readonly role: RestaurantRoleKey | null;
  /** The staff member's own branch; null for the owner (who chooses one). */
  readonly branchId: string | null;
}

export async function resolveAccess(tx: TenantClient, ctx: AuthContext): Promise<RestaurantAccess> {
  const company = await tx.company.findUnique({
    where: { id: ctx.companyId },
    select: { businessActivity: true },
  });
  const enabled = company?.businessActivity === RESTAURANT_ACTIVITY;
  const owner = enabled && OWNER_ROLES.includes(ctx.roleKey);
  if (!enabled || owner || !ctx.callerEmployeeId) {
    return { enabled, owner, employeeId: ctx.callerEmployeeId, role: null, branchId: null };
  }
  const staff = await tx.restaurantStaff.findFirst({
    where: {
      employeeId: ctx.callerEmployeeId,
      active: true,
      employee: { status: 'active', deletedAt: null },
      branch: { archivedAt: null },
    },
    select: { role: true, branchId: true },
  });
  return {
    enabled,
    owner,
    employeeId: ctx.callerEmployeeId,
    role: staff?.role ?? null,
    branchId: staff?.branchId ?? null,
  };
}

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

export function can(access: RestaurantAccess, action: RestaurantAction): boolean {
  if (!access.enabled) return false;
  if (access.owner) return true;
  return access.role !== null && roleAllows(access.role, action);
}

/** The actions the caller holds, for the screens (the server checks again on every call). */
export function actionsOf(access: RestaurantAccess): RestaurantAction[] {
  return ACTIONS.filter((action) => can(access, action));
}

/** 404 for a company that is not a restaurant; 403 without the action. */
export function requireAction(access: RestaurantAccess, action: RestaurantAction): void {
  if (!access.enabled) throw notFound();
  if (!can(access, action)) throw forbidden();
}

export function requireOwner(access: RestaurantAccess): void {
  if (!access.enabled) throw notFound();
  if (!access.owner) throw forbidden();
}

/**
 * The branch this request works in. Staff always get their own branch (a
 * different branch named in the request is a 404, as if it did not exist);
 * the owner must name an existing, open branch of the company.
 */
export async function resolveBranch(
  tx: TenantClient,
  access: RestaurantAccess,
  requested: string | undefined,
): Promise<string> {
  if (!access.owner) {
    if (!access.branchId) throw forbidden();
    if (requested && requested !== access.branchId) throw notFound();
    return access.branchId;
  }
  if (!requested) {
    // The owner's only open branch is chosen for them; with several, they must say which.
    const branches = await tx.restaurantBranch.findMany({
      where: { archivedAt: null },
      select: { id: true },
      take: 2,
    });
    if (branches.length === 1 && branches[0]) return branches[0].id;
    throw fieldError({ branch_id: ['required'] });
  }
  const branch = await tx.restaurantBranch.findFirst({
    where: { id: requested, archivedAt: null },
    select: { id: true },
  });
  if (!branch) throw notFound();
  return branch.id;
}
