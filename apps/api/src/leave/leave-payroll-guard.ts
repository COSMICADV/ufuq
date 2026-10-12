/**
 * DOCUMENT 16 rule 12 — "Leave in a finalized payroll period cannot be
 * approved" — and its edge cases (a retroactive request, and cancelling
 * approved leave, are blocked if the period is finalized).
 *
 * Every leave write that touches days (submission, approval, cancellation of
 * approved leave) asks this guard about those days inside its own
 * transaction, before changing anything. Phase 10 left a no-op binding until
 * payroll existed. Phase 11 binds the real check: the shared
 * `PayrollPeriodGuard`, raising `LEAVE_PERIOD_FINALIZED` (409, "تم إنهاء كشف
 * رواتب هذه الفترة. استخدم التسوية بدلاً من ذلك.") with the locked periods
 * named. The way forward is a payroll adjustment.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { CalendarDate } from '../attendance/zoned-time.js';
import { ERROR_CODES } from '../common/errors.js';
import { PayrollPeriodGuard } from '../payroll/payroll-period-guard.js';

export interface LeavePayrollGuard {
  /** Throws `LEAVE_PERIOD_FINALIZED` if any of `dates` lies in a finalized payroll period. */
  assertPeriodsOpen(
    tx: TenantClient,
    employeeId: string,
    dates: readonly CalendarDate[],
  ): Promise<void>;
}

export const LEAVE_PAYROLL_GUARD = Symbol('LEAVE_PAYROLL_GUARD');

/** Phase 11: a period is closed to leave from finalization on (finalized, paid, adjusted). */
@Injectable()
export class FinalizedPayrollLeaveGuard implements LeavePayrollGuard {
  constructor(@Inject(PayrollPeriodGuard) private readonly periods: PayrollPeriodGuard) {}

  assertPeriodsOpen(
    tx: TenantClient,
    _employeeId: string,
    dates: readonly CalendarDate[],
  ): Promise<void> {
    // Periods are company-wide months: a finalized month is closed for every employee.
    return this.periods.assertOpen(tx, dates, ERROR_CODES.LEAVE_PERIOD_FINALIZED);
  }
}
