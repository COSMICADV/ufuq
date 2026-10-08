/**
 * Request queries → Prisma — DOCUMENT 02 "Requests", DOCUMENT 09 §4,
 * DOCUMENT 08 §4.9.
 *
 * Pure, for the same reason as `task-query.ts` and `goal-query.ts`: the scope
 * rules are the ones most worth testing without a database. A caller's
 * filters are AND-ed with their scope, so a filter can never widen it.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';
import type { Prisma } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

type Caller = Pick<AuthContext, 'permissions' | 'callerEmployeeId'>;

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The requests a caller reaches through `permission` — DOCUMENT 02
 * "Requests": `self` is the caller's own, `team` those of the people who
 * report to them, `company` nothing beyond the tenant scope row-level security
 * already applies. A caller whose role grants `self` or `team` but who has no
 * employee record is refused rather than widened to everybody.
 */
export function requestScopeWhere(
  caller: Caller,
  permission: PermissionKey,
): Prisma.RequestWhereInput {
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
 * What `GET /requests` and `GET /requests/{id}` show: the caller's
 * `request.view` scope, **plus** their own requests. A manager's `team` scope
 * is the people who report to them, which does not include the manager — yet
 * C8 "My requests" is every submitter's own history. Being the requester is
 * always enough to see a request (as for attendance corrections, DOCUMENT 08
 * §4.5), and never enough to decide it.
 */
export function requestVisibleWhere(caller: Caller): Prisma.RequestWhereInput {
  const own: Prisma.RequestWhereInput[] =
    caller.callerEmployeeId === null ? [] : [{ employeeId: caller.callerEmployeeId }];
  let scoped: Prisma.RequestWhereInput[] = [];
  if (caller.permissions.has('request.view')) {
    try {
      scoped = [requestScopeWhere(caller, 'request.view')];
    } catch (error) {
      if (!(error instanceof AppException)) throw error;
    }
  }
  // A `company` scope is the empty condition — everything the tenant holds —
  // and already includes the caller's own. It must not go inside an `OR`:
  // Prisma reads `{}` there as matching nothing, which would shrink an
  // ADMIN-employee's view to their own requests.
  if (scoped.some((where) => Object.keys(where).length === 0)) {
    return {};
  }
  const reach = [...scoped, ...own];
  if (reach.length === 0) {
    throw forbidden();
  }
  return reach.length === 1 ? (reach[0] as Prisma.RequestWhereInput) : { OR: reach };
}

/**
 * The requests a caller may decide: their `request.review` scope, never their
 * own (OD-03, approved: "a Manager must never approve or reject their own
 * request"). A `team` scope already excludes the manager; the explicit clause
 * is what keeps a `company`-scoped ADMIN off their own request too.
 */
export function requestReviewableWhere(caller: Caller): Prisma.RequestWhereInput {
  const scope = requestScopeWhere(caller, 'request.review');
  return caller.callerEmployeeId === null
    ? scope
    : { AND: [scope, { employeeId: { not: caller.callerEmployeeId } }] };
}

/** Whether the caller holds `request.review` at a scope that resolves. */
export function canReview(caller: Caller): boolean {
  if (!caller.permissions.has('request.review')) return false;
  try {
    requestScopeWhere(caller, 'request.review');
    return true;
  } catch (error) {
    if (error instanceof AppException) return false;
    throw error;
  }
}
