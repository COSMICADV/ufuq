/**
 * The V1 company reports and who may read them — DOCUMENT 18 "Company
 * reports", DOCUMENT 02 "Reports", DOCUMENT 08 §4.12.
 *
 * Two kinds:
 *
 *   - **People reports** (attendance, performance, tasks, goals): readable
 *     with `report.company` (the whole company) or `report.team` (the
 *     caller's team). DOCUMENT 18 rule 4: a manager's "company" report is
 *     scoped to their team, and the scope is stated on the report.
 *   - **Company-only reports** (payroll, inventory, warehouse, stock
 *     movements): `report.company` only. A MANAGER never reads them —
 *     not through `report.team`, and not through `report.export`.
 *
 * Export needs `report.export` **and** the right to read the report being
 * exported (DOCUMENT 18 "Exports respect the caller's permissions").
 *
 * Pure, so the rules are unit-tested without a database.
 */

import { resolveScope, ScopeResolutionError } from '@ufuq/auth';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

export const REPORT_KEYS = [
  'attendance',
  'performance',
  'tasks',
  'goals',
  'payroll',
  'inventory',
  'warehouse',
  'stock-movements',
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** The reports a manager may read for their team (DOCUMENT 02: `report.team`). */
export const PEOPLE_REPORTS: readonly ReportKey[] = ['attendance', 'performance', 'tasks', 'goals'];

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}

export function isPeopleReport(key: ReportKey): boolean {
  return PEOPLE_REPORTS.includes(key);
}

/**
 * Whose rows a report covers — always stated on the report itself
 * (DOCUMENT 18 rule 4), in exports too (rule 7).
 */
export type ReportScope =
  | { readonly type: 'company' }
  | { readonly type: 'team'; readonly manager_employee_id: string };

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

/**
 * The scope the caller reads `key` at, or 403. `report.company` wins: an
 * ADMIN reads the whole company. Otherwise a people report resolves the
 * caller's `report.team` scope — `team` is the employees whose manager the
 * caller is. A caller whose team scope cannot be resolved (no employee
 * record) is refused rather than widened.
 */
export function reportScope(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  key: ReportKey,
): ReportScope {
  const company = ctx.permissions.get('report.company');
  if (company === 'company' || company === 'platform') {
    return { type: 'company' };
  }
  if (!isPeopleReport(key)) {
    throw forbidden();
  }
  const team = ctx.permissions.get('report.team');
  if (team === undefined) {
    throw forbidden();
  }
  try {
    const constraint = resolveScope(team, { callerEmployeeId: ctx.callerEmployeeId });
    switch (constraint.kind) {
      case 'company':
      case 'platform':
        return { type: 'company' };
      case 'team':
        return { type: 'team', manager_employee_id: constraint.managerEmployeeId };
      case 'self':
        // DOCUMENT 02: no role reads a company report at self scope.
        throw forbidden();
    }
  } catch (error) {
    if (error instanceof ScopeResolutionError) {
      throw forbidden();
    }
    throw error;
  }
}

/** Export: `report.export` and the right to read `key` (DOCUMENT 18 "Export & print"). */
export function exportScope(
  ctx: Pick<AuthContext, 'permissions' | 'callerEmployeeId'>,
  key: ReportKey,
): ReportScope {
  if (!ctx.permissions.has('report.export')) {
    throw forbidden();
  }
  const scope = reportScope(ctx, key);
  const exportGrant = ctx.permissions.get('report.export');
  // DOCUMENT 02: MANAGER exports at team scope only. A company-scope read
  // with a narrower export grant is refused rather than silently widened.
  if (scope.type === 'company' && exportGrant !== 'company' && exportGrant !== 'platform') {
    throw forbidden();
  }
  return scope;
}
