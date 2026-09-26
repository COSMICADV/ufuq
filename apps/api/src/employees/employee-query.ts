/**
 * `GET /employees` query → Prisma — DOCUMENT 08 §4.3, DOCUMENT 09 §4.
 *
 * Pure functions, so the rules can be tested without a database:
 *
 *   - Ownership scope becomes a `where` constraint *before* anything is fetched
 *     (DOCUMENT 02 §5.3: "never fetch then discard").
 *   - Filters and search are whitelisted in the DTO; here they only become
 *     conditions. Every condition is AND-ed, so a filter can narrow a scope and
 *     can never widen it — a MANAGER passing `manager_id` of someone else's
 *     manager still sees only their own team.
 *   - Sorting is a closed set with a stable tiebreak on `id` (UUID v7, so
 *     creation order), which keeps pages from overlapping.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';
import type { PermissionKey } from '@ufuq/auth';
import type { Locale } from '@ufuq/i18n';
import type { Prisma } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

import type { EmployeeSort, ListEmployeesQueryDto, SortOrder } from './dto/employee.dto.js';

/** 403 — DOCUMENT 09 §4 check 4, "the permission's scope does not reach the target row". */
export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The rows a caller may reach through `permission` — DOCUMENT 09 §4 table:
 * `self` → their own employee row, `team` → employees whose manager they are,
 * `company` → no constraint beyond the tenant scope row-level security
 * already applies.
 *
 * A caller whose role grants `self` or `team` but who has no employee record
 * cannot have that scope resolved, and is refused rather than widened.
 */
export function employeeScopeWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  permission: PermissionKey,
): Prisma.EmployeeWhereInput {
  const scope = ctx.permissions.get(permission);
  if (scope === undefined) {
    throw forbidden();
  }
  try {
    const constraint = resolveScope(scope, { callerEmployeeId: ctx.callerEmployeeId });
    switch (constraint.kind) {
      case 'self':
        return { id: constraint.employeeId };
      case 'team':
        return { managerId: constraint.managerEmployeeId };
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

export function filterWhere(query: ListEmployeesQueryDto): Prisma.EmployeeWhereInput {
  return {
    ...(query.department_id === undefined ? {} : { departmentId: query.department_id }),
    ...(query.position_id === undefined ? {} : { positionId: query.position_id }),
    ...(query.manager_id === undefined ? {} : { managerId: query.manager_id }),
    ...(query.status === undefined ? {} : { status: query.status }),
  };
}

/** At most this many words of a search are used; the rest add nothing but cost. */
export const MAX_SEARCH_TERMS = 5;

/**
 * DOCUMENT 08 §4.3: "search: name, code, email". Each word must match one of
 * those columns, so "سارة أحمد" finds Sara Ahmed whichever name holds which
 * word. Case-insensitive; the DTO has already normalised Arabic-Indic digits.
 */
export function searchWhere(search: string | undefined): Prisma.EmployeeWhereInput {
  const terms = (search ?? '').split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) {
    return {};
  }
  return {
    AND: terms.slice(0, MAX_SEARCH_TERMS).map((term) => ({
      OR: [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName: { contains: term, mode: 'insensitive' } },
        { employeeCode: { contains: term, mode: 'insensitive' } },
        { email: { contains: term, mode: 'insensitive' } },
      ],
    })),
  };
}

export function orderByFor(
  sort: EmployeeSort,
  order: SortOrder,
  locale: Locale,
): Prisma.EmployeeOrderByWithRelationInput[] {
  switch (sort) {
    case 'name':
      return [{ firstName: order }, { lastName: order }, { id: 'asc' }];
    case 'joining_date':
      return [{ joiningDate: order }, { id: 'asc' }];
    case 'department':
      // The department name the reader sees is the one they sort by.
      return [
        { department: locale === 'en' ? { nameEn: order } : { nameAr: order } },
        { firstName: 'asc' },
        { id: 'asc' },
      ];
  }
}

export function listWhere(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  query: ListEmployeesQueryDto,
): Prisma.EmployeeWhereInput {
  return {
    AND: [
      { deletedAt: null },
      employeeScopeWhere(ctx, 'employee.view'),
      filterWhere(query),
      searchWhere(query.search),
    ],
  };
}
