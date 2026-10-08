/**
 * Task queries → Prisma — DOCUMENT 08 §4.7, DOCUMENT 09 §4, DOCUMENT 13.
 *
 * Pure, for the same reason as `employee-query.ts` and `attendance-query.ts`:
 * the scope rules are the ones most worth testing without a database.
 *
 * The invariant: a caller's filters are AND-ed with their scope. A MANAGER
 * holding `task.view` at `team` scope who filters by an assignee outside
 * their team gets an empty list, never somebody else's tasks.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';
import type { Prisma } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { parseCalendarDate } from '../company-structure/validation.js';

import type { ListTasksQueryDto } from './dto/task.dto.js';
import { OPEN_STATUSES } from './task-rules.js';

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The tasks a caller reaches through `permission` — DOCUMENT 02 "Tasks",
 * DOCUMENT 09 §4: `self` is a task assigned to the caller ("self (assigned)"),
 * `team` a task assigned to someone who reports to them, `company` adds
 * nothing beyond the tenant scope row-level security already applies. A
 * caller whose role grants `self` or `team` but who has no employee record is
 * refused rather than widened to everybody.
 */
export function taskScopeWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): Prisma.TaskWhereInput {
  const scope = ctx.permissions.get(permission);
  if (scope === undefined) {
    throw forbidden();
  }
  try {
    const constraint = resolveScope(scope, { callerEmployeeId: ctx.callerEmployeeId });
    switch (constraint.kind) {
      case 'self':
        return { assigneeEmployeeId: constraint.employeeId };
      case 'team':
        return { assignee: { managerId: constraint.managerEmployeeId } };
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

/** A `@db.Date` column is matched at midnight UTC, whatever the company zone. */
export function dateValue(day: string): Date {
  const parsed = parseCalendarDate(day);
  if (parsed === null) {
    throw new RangeError(`Not a calendar date: ${day}`);
  }
  return parsed;
}

/**
 * Rule 1 as a query: `deadline < today AND status ∉ {completed, cancelled}`.
 * `today` is the company's calendar day, never the server's or the browser's.
 */
export function overdueWhere(today: string): Prisma.TaskWhereInput {
  return { deadline: { lt: dateValue(today) }, status: { in: [...OPEN_STATUSES] } };
}

/**
 * The negation, for `?overdue=false`: no deadline, a deadline today or later,
 * or a closed task. Spelled out rather than `NOT overdueWhere`, because SQL's
 * `NOT (deadline < x AND …)` is NULL — not true — for a task with no deadline.
 */
export function notOverdueWhere(today: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { deadline: null },
      { deadline: { gte: dateValue(today) } },
      { status: { in: ['completed', 'cancelled'] } },
    ],
  };
}

/**
 * DOCUMENT 13 "tasks needing reassignment": open tasks whose assignee has been
 * deactivated or terminated (any status but `active`), or removed. Completed
 * and cancelled tasks need nobody, so they are not listed.
 */
export function needsReassignmentWhere(): Prisma.TaskWhereInput {
  return {
    status: { in: [...OPEN_STATUSES] },
    assignee: { OR: [{ status: { not: 'active' } }, { deletedAt: { not: null } }] },
  };
}

/**
 * DOCUMENT 08 §4.7's filters, AND-ed with the scope and with the soft-delete
 * scope (DOCUMENT 06 §6: soft-deleted rows are excluded by default).
 */
export function listWhere(
  scope: Prisma.TaskWhereInput,
  query: ListTasksQueryDto,
  today: string,
): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [{ deletedAt: null }, scope];
  if (query.status !== undefined) {
    and.push({ status: query.status });
  }
  if (query.priority !== undefined) {
    and.push({ priority: query.priority });
  }
  if (query.assignee_employee_id !== undefined) {
    and.push({ assigneeEmployeeId: query.assignee_employee_id });
  }
  if (query.department_id !== undefined) {
    and.push({ departmentId: query.department_id });
  }
  if (query.goal_id !== undefined) {
    and.push({ goalId: query.goal_id });
  }
  if (query.overdue === 'true') {
    and.push(overdueWhere(today));
  } else if (query.overdue === 'false') {
    and.push(notOverdueWhere(today));
  }
  if (query.from !== undefined) {
    and.push({ deadline: { gte: dateValue(query.from) } });
  }
  if (query.to !== undefined) {
    and.push({ deadline: { lte: dateValue(query.to) } });
  }
  if (query.needs_reassignment === 'true') {
    and.push(needsReassignmentWhere());
  }
  return { AND: and };
}

/**
 * Nearest deadline first, undated work last, newest first within a day; `id`
 * as the final tiebreak so two equal rows cannot swap between pages.
 */
export const LIST_ORDER: Prisma.TaskOrderByWithRelationInput[] = [
  { deadline: { sort: 'asc', nulls: 'last' } },
  { createdAt: 'desc' },
  { id: 'asc' },
];
