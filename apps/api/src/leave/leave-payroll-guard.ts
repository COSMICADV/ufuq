/**
 * DOCUMENT 16 rule 12 — "Leave in a finalized payroll period cannot be
 * approved" — and its edge cases (a retroactive request, and cancelling
 * approved leave, are blocked if the period is finalized).
 *
 * Payroll periods are Phase 11 (DOCUMENT 25); no payroll table exists yet,
 * and none is faked here. The rule therefore has exactly one integration
 * point: every leave write that touches days (submission, approval,
 * cancellation of approved leave) asks this guard about those days inside
 * its own transaction, before changing anything. Phase 11 provides the real
 * guard under `LEAVE_PAYROLL_GUARD`: it throws `LEAVE_PERIOD_FINALIZED`
 * (409, "تم إنهاء كشف رواتب هذه الفترة") when any day falls in a finalized
 * period of the employee's company. Nothing else in the leave module changes.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { CalendarDate } from '../attendance/zoned-time.js';

export interface LeavePayrollGuard {
  /** Throws `LEAVE_PERIOD_FINALIZED` if any of `dates` lies in a finalized payroll period. */
  assertPeriodsOpen(
    tx: TenantClient,
    employeeId: string,
    dates: readonly CalendarDate[],
  ): Promise<void>;
}

export const LEAVE_PAYROLL_GUARD = Symbol('LEAVE_PAYROLL_GUARD');

/** Until Phase 11 there is no payroll period, so none can be finalized. */
@Injectable()
export class NoPayrollPeriodsGuard implements LeavePayrollGuard {
  assertPeriodsOpen(): Promise<void> {
    return Promise.resolve();
  }
}
