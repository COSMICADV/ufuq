/**
 * Attendance queries → Prisma — DOCUMENT 08 §4.4–4.5, DOCUMENT 09 §4.
 *
 * Pure, for the same reason as `employee-query.ts`: the scope rules are the
 * ones most worth testing without a database in the way.
 *
 * The invariant that matters here is that a caller's filters are AND-ed with
 * their scope. A MANAGER holding `attendance.view` at `team` scope who passes
 * `employee_id` of somebody outside their team gets an empty list, never
 * somebody else's attendance.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';
import type { Prisma } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

import { formatCalendarDate } from './zoned-time.js';
import type { CalendarDate } from './zoned-time.js';

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The employees a caller may see attendance for, expressed as a constraint on
 * `attendance_records.employee` — DOCUMENT 02 §5.3 ("never fetch then
 * discard"), DOCUMENT 09 §4.
 *
 * `self` is the employee themselves; `team` is the employees who report to
 * them; `company` adds nothing beyond the tenant scope row-level security
 * already applies. A caller whose role grants `self` or `team` but who has no
 * employee record is refused rather than widened to everybody.
 */
export function attendanceScopeWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): Prisma.AttendanceRecordWhereInput {
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

/** The same scope, as a constraint on a correction request. */
export function correctionScopeWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): Prisma.AttendanceCorrectionRequestWhereInput {
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

/** A `@db.Date` column is matched at midnight UTC, whatever the company zone. */
export function dateValue(date: CalendarDate): Date {
  return new Date(`${formatCalendarDate(date)}T00:00:00.000Z`);
}

export interface AttendanceFilters {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  readonly departmentId?: string;
  readonly employeeId?: string;
  readonly status?: string;
  readonly workMode?: string;
}

/**
 * DOCUMENT 08 §4.4's filters, AND-ed with the scope. The date window is always
 * present: an unbounded attendance list is a table scan that grows forever.
 */
export function listWhere(
  scope: Prisma.AttendanceRecordWhereInput,
  filters: AttendanceFilters,
): Prisma.AttendanceRecordWhereInput {
  const employeeConstraints: Prisma.EmployeeWhereInput[] = [];
  if (filters.departmentId !== undefined) {
    employeeConstraints.push({ departmentId: filters.departmentId });
  }

  const and: Prisma.AttendanceRecordWhereInput[] = [
    scope,
    { date: { gte: dateValue(filters.from), lte: dateValue(filters.to) } },
  ];
  if (filters.employeeId !== undefined) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.status !== undefined) {
    and.push({ status: filters.status as never });
  }
  if (filters.workMode !== undefined) {
    and.push({ workMode: filters.workMode as never });
  }
  if (employeeConstraints.length > 0) {
    and.push({ employee: { AND: employeeConstraints } });
  }
  return { AND: and };
}

/**
 * Ordering for the daily board and the history list — DOCUMENT 04 B5.
 *
 * Date descending puts the most recent day first in a history; within a day,
 * employees sort by code so the board is stable between refreshes. `id` is the
 * final tiebreak for the same reason as in Phase 4: without one, two rows
 * comparing equal can swap between pages.
 */
export const LIST_ORDER: Prisma.AttendanceRecordOrderByWithRelationInput[] = [
  { date: 'desc' },
  { employee: { employeeCode: 'asc' } },
  { id: 'asc' },
];
