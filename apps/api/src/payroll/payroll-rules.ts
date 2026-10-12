/**
 * Payroll's state machine and access rules — DOCUMENT 15 "PAYROLL STATES",
 * "PERMISSIONS", DOCUMENT 02 "Payroll", OD-07 A.
 *
 * Pure: nothing here touches the database, so the transitions and the scope
 * rules are unit-tested on their own and every service path consults the
 * same table.
 */

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

export const PERIOD_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'finalized',
  'paid',
  'adjusted',
] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/** Locked from finalization on (DOCUMENT 15 rule 1). */
export const LOCKED_STATUSES: readonly PeriodStatus[] = ['finalized', 'paid', 'adjusted'];
/** Deductions and bonuses (DOCUMENT 15 "PAYROLL STATES"). */
export const EDITABLE_STATUSES: readonly PeriodStatus[] = ['draft', 'under_review'];

export type PeriodAction =
  | 'recalculate'
  | 'submit_review'
  | 'approve'
  | 'return_to_draft'
  | 'return_to_review'
  | 'finalize'
  | 'mark_paid'
  | 'add_entry'
  | 'adjust';

/**
 * Every action and the states it is allowed from. Anything else is a 409
 * (`PAYROLL_INVALID_TRANSITION`), checked again under the period lock.
 *
 *   draft        → under_review (submit)        · recalculate · entries
 *   under_review → approved | draft             · entries
 *   approved     → finalized | under_review
 *   finalized    → paid · adjustments (→ adjusted)
 *   paid         → adjustments (→ adjusted)
 *   adjusted     → adjustments; mark paid while not yet paid (approved
 *                  decision: the status stays `adjusted`)
 */
const ALLOWED_FROM: Readonly<Record<PeriodAction, readonly PeriodStatus[]>> = {
  recalculate: ['draft'],
  submit_review: ['draft'],
  approve: ['under_review'],
  return_to_draft: ['under_review'],
  return_to_review: ['approved'],
  finalize: ['approved'],
  mark_paid: ['finalized', 'adjusted'],
  add_entry: EDITABLE_STATUSES,
  adjust: LOCKED_STATUSES,
};

export function isAllowed(
  action: PeriodAction,
  status: PeriodStatus,
  paidAt: Date | null = null,
): boolean {
  if (!ALLOWED_FROM[action].includes(status)) return false;
  // An adjusted period is paid at most once.
  if (action === 'mark_paid' && status === 'adjusted' && paidAt !== null) return false;
  return true;
}

/** The status after a successful action. */
export function nextStatus(action: PeriodAction, status: PeriodStatus): PeriodStatus {
  switch (action) {
    case 'submit_review':
    case 'return_to_review':
      return 'under_review';
    case 'approve':
      return 'approved';
    case 'return_to_draft':
      return 'draft';
    case 'finalize':
      return 'finalized';
    case 'mark_paid':
      return status === 'adjusted' ? 'adjusted' : 'paid';
    case 'adjust':
      return 'adjusted';
    case 'recalculate':
    case 'add_entry':
      return status;
  }
}

export function assertAllowed(
  action: PeriodAction,
  status: PeriodStatus,
  paidAt: Date | null = null,
): void {
  if (isAllowed(action, status, paidAt)) return;
  if (action === 'add_entry' && LOCKED_STATUSES.includes(status)) {
    throw new AppException(ERROR_CODES.PAYROLL_LINE_LOCKED, 409);
  }
  if (action === 'recalculate' && LOCKED_STATUSES.includes(status)) {
    throw new AppException(ERROR_CODES.PAYROLL_PERIOD_FINALIZED, 409);
  }
  throw new AppException(ERROR_CODES.PAYROLL_INVALID_TRANSITION, 409, {
    fields: { status: [status] },
  });
}

/** `YYYY-MM` — the period identifier the finalization confirmation must type. */
export function periodLabel(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

export function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

type Caller = Pick<AuthContext, 'permissions' | 'callerEmployeeId'>;

/**
 * What a payroll or salary permission reaches. OD-07 A: only `company` (ADMIN)
 * and `self` (EMPLOYEE) exist; MANAGER holds neither permission, and a `team`
 * scope, should one ever be granted, is refused rather than widened.
 */
export type PayrollReach =
  | { readonly kind: 'company' }
  | { readonly kind: 'self'; readonly employeeId: string };

export function payrollReach(caller: Caller, permission: string): PayrollReach {
  const scope = caller.permissions.get(permission);
  if (scope === 'company' || scope === 'platform') return { kind: 'company' };
  if (scope === 'self') {
    if (caller.callerEmployeeId === null) throw forbidden();
    return { kind: 'self', employeeId: caller.callerEmployeeId };
  }
  throw forbidden();
}

/** Company-wide only — period lists, runs and every write. */
export function requireCompany(caller: Caller, permission: string): void {
  if (payrollReach(caller, permission).kind !== 'company') throw forbidden();
}

export const ENTRY_REASON_MIN = 3;
export const ENTRY_REASON_MAX = 1000;
export const ENTRY_TYPE_MAX = 50;
