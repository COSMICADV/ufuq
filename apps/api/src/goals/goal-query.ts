/**
 * Goal queries → Prisma — DOCUMENT 02 "Goals", DOCUMENT 09 §4, DOCUMENT 14.
 *
 * Pure, for the same reason as `task-query.ts`: the scope rules are the ones
 * most worth testing without a database. A caller's filters are AND-ed with
 * their scope, so a filter can never widen it.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';
import type { Prisma } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

import type { ListGoalsQueryDto } from './dto/goal.dto.js';

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The goals a caller reaches through `permission` — DOCUMENT 02 "Goals":
 * `self` is the caller's own goals, `team` the goals of the people who report
 * to them, `company` nothing beyond the tenant scope row-level security
 * already applies. A caller whose role grants `self` or `team` but who has no
 * employee record is refused rather than widened to everybody.
 */
export function goalScopeWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): Prisma.GoalWhereInput {
  const scope = ctx.permissions.get(permission);
  if (scope === undefined) {
    throw forbidden();
  }
  try {
    const constraint = resolveScope(scope, { callerEmployeeId: ctx.callerEmployeeId });
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

/** Whether the caller holds `permission` at a scope that can be resolved. */
export function hasGoalScope(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): boolean {
  try {
    goalScopeWhere(ctx, permission);
    return true;
  } catch (error) {
    if (error instanceof AppException) {
      return false;
    }
    throw error;
  }
}

/** The list filters, AND-ed with the scope and the soft-delete scope (DOCUMENT 06 §6). */
export function listWhere(
  scope: Prisma.GoalWhereInput,
  query: ListGoalsQueryDto,
): Prisma.GoalWhereInput {
  const and: Prisma.GoalWhereInput[] = [{ deletedAt: null }, scope];
  if (query.employee_id !== undefined) {
    and.push({ employeeId: query.employee_id });
  }
  if (query.type !== undefined) {
    and.push({ type: query.type });
  }
  if (query.status !== undefined) {
    and.push({ status: query.status });
  }
  return { AND: and };
}

/**
 * Nearest period end first — DOCUMENT 04 B1's "goals by proximity to
 * deadline" reads straight off it — then newest; `id` as the final tiebreak
 * so two equal rows cannot swap between pages.
 */
export const LIST_ORDER: Prisma.GoalOrderByWithRelationInput[] = [
  { periodEnd: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
];
