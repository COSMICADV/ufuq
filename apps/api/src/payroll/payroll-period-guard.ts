/**
 * The one finalized-payroll check — DOCUMENT 15 rule 12, DOCUMENT 12
 * ("attendance in a finalized payroll period cannot be changed"), DOCUMENT 16
 * rule 12 ("leave in a finalized payroll period cannot be approved").
 *
 * A payroll period is locked from finalization on: `finalized`, `paid` or
 * `adjusted`. A change to attendance or leave on a date inside a locked
 * period would make the attendance disagree with pay that can no longer
 * change, so it is refused (409), and the only way forward is a payroll
 * adjustment.
 *
 * Every caller (attendance writes, correction approval, leave submission,
 * approval and cancellation) asks this one class inside its own transaction,
 * before changing anything. No other module queries payroll periods.
 */

import { Injectable } from '@nestjs/common';
import type { TenantClient } from '@ufuq/db';

import type { CalendarDate } from '../attendance/zoned-time.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import type { ErrorCode } from '../common/errors.js';

export const LOCKED_PERIOD_STATUSES = ['finalized', 'paid', 'adjusted'] as const;

function monthKey(year: number, month: number): string {
  return `${String(year)}-${String(month).padStart(2, '0')}`;
}

@Injectable()
export class PayrollPeriodGuard {
  /** The `YYYY-MM` of every locked period that contains one of `dates`. */
  async lockedMonths(tx: TenantClient, dates: readonly CalendarDate[]): Promise<string[]> {
    if (dates.length === 0) return [];
    const months = new Map<string, { year: number; month: number }>();
    for (const date of dates) {
      months.set(monthKey(date.year, date.month), { year: date.year, month: date.month });
    }
    const rows = await tx.payrollPeriod.findMany({
      where: {
        status: { in: [...LOCKED_PERIOD_STATUSES] },
        OR: [...months.values()].map(({ year, month }) => ({ year, month })),
      },
      select: { year: true, month: true },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
    });
    return rows.map((row) => monthKey(row.year, row.month));
  }

  /** Throws 409 `code` (default `PAYROLL_PERIOD_FINALIZED`), naming the locked periods. */
  async assertOpen(
    tx: TenantClient,
    dates: readonly CalendarDate[],
    code: ErrorCode = ERROR_CODES.PAYROLL_PERIOD_FINALIZED,
  ): Promise<void> {
    const locked = await this.lockedMonths(tx, dates);
    if (locked.length > 0) {
      throw new AppException(code, 409, { fields: { periods: locked } });
    }
  }
}
