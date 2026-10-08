/**
 * Leave queries → Prisma — DOCUMENT 02 "Leave", DOCUMENT 09 §4.
 *
 * Pure, like `request-query.ts`. A leave request and a leave balance both
 * belong to an employee, so the same scope shape serves both tables. Filters
 * are AND-ed with scope, so a filter can never widen it.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

type Caller = Pick<AuthContext, 'permissions' | 'callerEmployeeId'>;

/** The employee-owned shape both `leave_requests` and `leave_balances` filter on. */
export type EmployeeOwnedWhere =
  | Record<string, never>
  | { readonly employeeId: string }
  | { readonly employee: { readonly managerId: string } }
  | { OR: EmployeeOwnedWhere[] };

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * What `permission` reaches — DOCUMENT 02 "Leave": `self` the caller's own,
 * `team` the people who report to them, `company` everything row-level
 * security already allows. An unresolvable scope is refused, never widened.
 */
export function leaveScopeWhere(caller: Caller, permission: PermissionKey): EmployeeOwnedWhere {
  const scope = caller.permissions.get(permission);
  if (scope === undefined) {
    throw forbidden();
  }
  try {
    const constraint = resolveScope(scope, { callerEmployeeId: caller.callerEmployeeId });
    switch (constraint.kind) {
      case 'self':
        return { employeeId: constraint.employeeId };
      case 'team':
        return { employee: { managerId: constraint.managerEmployeeId } };
      case 'company':
      case 'platform':
        return {};
    }
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      throw forbidden();
    }
    throw error;
  }
}

/**
 * What a caller may see: their `leave.view` scope plus their own leave, as
 * for requests (a manager's `team` scope does not include themselves). A
 * `company` scope is returned bare — Prisma reads `{}` inside an `OR` as
 * matching nothing (the Phase 9 lesson).
 */
export function leaveVisibleWhere(caller: Caller): EmployeeOwnedWhere {
  let scoped: EmployeeOwnedWhere | null = null;
  if (caller.permissions.has('leave.view')) {
    try {
      scoped = leaveScopeWhere(caller, 'leave.view');
    } catch (error) {
      if (!(error instanceof AppException)) throw error;
    }
  }
  if (scoped !== null && Object.keys(scoped).length === 0) {
    return {};
  }
  const reach: EmployeeOwnedWhere[] = [
    ...(scoped === null ? [] : [scoped]),
    ...(caller.callerEmployeeId === null ? [] : [{ employeeId: caller.callerEmployeeId }]),
  ];
  if (reach.length === 0) {
    throw forbidden();
  }
  return reach.length === 1 ? (reach[0] as EmployeeOwnedWhere) : { OR: reach };
}

/** Whether the caller holds `permission` at `company` scope (DOCUMENT 16 rule 15: "an admin"). */
export function hasCompanyScope(caller: Caller, permission: PermissionKey): boolean {
  return caller.permissions.get(permission) === 'company';
}
