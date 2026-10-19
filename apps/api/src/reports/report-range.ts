/**
 * A report's date range — DOCUMENT 18 "Filters": "Default range is the
 * current month. Ranges longer than 12 months require confirmation."
 *
 * Dates are calendar days in the company's timezone (DOCUMENT 11 §9), as
 * every other date filter in the API. Pure; unit-tested.
 *
 *   - Neither end given: the current month, first to last day.
 *   - Only `from`: to the end of the current month, or of `from`'s month if
 *     that is later. Only `to`: from the first day of `to`'s month.
 *   - `from` after `to`: 422 `to: end_before_start`.
 *   - Longer than 12 months (the day after `from` plus 12 months is still
 *     inside the range) without `confirm_large_range=true`: 409
 *     `REPORT_RANGE_CONFIRMATION_REQUIRED`. Nothing heavy runs silently.
 */

import {
  compareDates,
  daysBetween,
  formatCalendarDate,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { fieldError } from '../company-structure/tenant-scoped.service.js';
import { monthOf } from '../performance/performance-month.js';
import type { Month } from '../performance/performance-month.js';

/** DOCUMENT 18: longer than this needs an explicit confirmation. */
export const MAX_UNCONFIRMED_MONTHS = 12;
/** Up to this many days a trend is drawn per day; longer, per month. */
export const DAILY_TREND_MAX_DAYS = 92;

export interface ReportRange {
  readonly from: CalendarDate;
  readonly to: CalendarDate;
  /** `YYYY-MM-DD` forms, for responses and SQL parameters. */
  readonly fromKey: string;
  readonly toKey: string;
  readonly days: number;
  readonly large: boolean;
}

export interface RangeInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly confirm_large_range?: boolean | undefined;
}

function lastDayOfMonth(date: CalendarDate): CalendarDate {
  return monthOf(date.year, date.month).last;
}

/** `date` plus `months` calendar months, clamped to the target month's last day. */
export function addMonths(date: CalendarDate, months: number): CalendarDate {
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = monthOf(year, month).last.day;
  return { year, month, day: Math.min(date.day, last) };
}

export function resolveRange(input: RangeInput, today: CalendarDate): ReportRange {
  const parsedFrom = input.from === undefined ? null : parseCalendarDate(input.from);
  const parsedTo = input.to === undefined ? null : parseCalendarDate(input.to);
  if (input.from !== undefined && parsedFrom === null) {
    throw fieldError({ from: ['invalid'] });
  }
  if (input.to !== undefined && parsedTo === null) {
    throw fieldError({ to: ['invalid'] });
  }
  const currentFirst: CalendarDate = { year: today.year, month: today.month, day: 1 };
  const currentLast = lastDayOfMonth(today);

  let from: CalendarDate;
  let to: CalendarDate;
  if (parsedFrom === null && parsedTo === null) {
    from = currentFirst;
    to = currentLast;
  } else if (parsedFrom !== null && parsedTo === null) {
    from = parsedFrom;
    const ownLast = lastDayOfMonth(parsedFrom);
    to = compareDates(ownLast, currentLast) > 0 ? ownLast : currentLast;
  } else if (parsedFrom === null && parsedTo !== null) {
    to = parsedTo;
    from = { year: parsedTo.year, month: parsedTo.month, day: 1 };
  } else {
    from = parsedFrom as CalendarDate;
    to = parsedTo as CalendarDate;
  }
  if (compareDates(from, to) > 0) {
    throw fieldError({ to: ['end_before_start'] });
  }
  const limit = addMonths(from, MAX_UNCONFIRMED_MONTHS);
  // `from` + 12 months is the first day *outside* a 12-month range.
  const large = compareDates(to, limit) >= 0;
  if (large && input.confirm_large_range !== true) {
    throw new AppException(ERROR_CODES.REPORT_RANGE_CONFIRMATION_REQUIRED, 409, {
      fields: { range: [`more_than_${String(MAX_UNCONFIRMED_MONTHS)}_months`] },
    });
  }
  return {
    from,
    to,
    fromKey: formatCalendarDate(from),
    toKey: formatCalendarDate(to),
    days: daysBetween(from, to) + 1,
    large,
  };
}

/** The trend granularity for a range: a day per point, or a month for long ranges. */
export function trendUnit(range: ReportRange): 'day' | 'month' {
  return range.days <= DAILY_TREND_MAX_DAYS ? 'day' : 'month';
}

/**
 * The calendar months a range touches, up to the current month — a future
 * month has no performance yet (DOCUMENT 14 is computed per month).
 */
export function monthsIn(range: ReportRange, today: CalendarDate): readonly Month[] {
  const months: Month[] = [];
  let cursor: CalendarDate = { year: range.from.year, month: range.from.month, day: 1 };
  const end: CalendarDate = { year: range.to.year, month: range.to.month, day: 1 };
  const current: CalendarDate = { year: today.year, month: today.month, day: 1 };
  while (compareDates(cursor, end) <= 0 && compareDates(cursor, current) <= 0) {
    months.push(monthOf(cursor.year, cursor.month));
    cursor = addMonths(cursor, 1);
  }
  return months;
}
