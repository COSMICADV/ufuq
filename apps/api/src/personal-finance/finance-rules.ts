/**
 * 1to1OS Personal — Expenses: the rules that are pure, so they are tested
 * without a database.
 *
 *   - The default categories (keys; their labels are translated on the web).
 *   - A period ("today", "week", "month", "year", or a custom range) turned
 *     into an instant range in the account's own time zone — a purchase at
 *     11:30 pm in Cairo belongs to that Cairo day, whatever the server's zone.
 */

import {
  calendarDateIn,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';

export const ACCOUNT_TYPES = [
  'cash',
  'bank',
  'debit_card',
  'credit_card',
  'ewallet',
  'savings',
] as const;
export type AccountTypeValue = (typeof ACCOUNT_TYPES)[number];

export const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
export type TransactionTypeValue = (typeof TRANSACTION_TYPES)[number];

export const PERIODS = ['today', 'week', 'month', 'year', 'custom'] as const;
export type PeriodValue = (typeof PERIODS)[number];

/** The editable defaults, created the first time a person opens Expenses. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'food',
  'groceries',
  'transport',
  'fuel',
  'car_maintenance',
  'home',
  'bills',
  'health',
  'shopping',
  'education',
  'entertainment',
  'subscriptions',
  'other',
] as const;

export const DEFAULT_INCOME_CATEGORIES = ['salary', 'business', 'gift', 'other_income'] as const;

export interface InstantRange {
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
  readonly firstDay: string;
  readonly lastDay: string;
}

function addDays(date: CalendarDate, days: number): CalendarDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

/** Saturday-first weeks, as the week is lived in Egypt. */
function weekStart(date: CalendarDate): CalendarDate {
  const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  const sinceSaturday = (weekday + 1) % 7;
  return addDays(date, -sinceSaturday);
}

function range(first: CalendarDate, last: CalendarDate, timeZone: string): InstantRange {
  return {
    from: instantAt(first, 0, timeZone),
    to: instantAt(addDays(last, 1), 0, timeZone),
    firstDay: formatCalendarDate(first),
    lastDay: formatCalendarDate(last),
  };
}

/**
 * The instant range of a period around `now`, in `timeZone`. A custom range
 * needs both days, `from` ≤ `to`, and spans at most 3 years; null otherwise.
 */
export function periodRange(
  period: PeriodValue,
  now: Date,
  timeZone: string,
  custom?: { readonly from?: string | undefined; readonly to?: string | undefined },
): InstantRange | null {
  const today = calendarDateIn(now, timeZone);
  switch (period) {
    case 'today':
      return range(today, today, timeZone);
    case 'week': {
      const first = weekStart(today);
      return range(first, addDays(first, 6), timeZone);
    }
    case 'month': {
      const first = { year: today.year, month: today.month, day: 1 };
      const last = addDays({ year: today.year, month: today.month + 1, day: 1 }, -1);
      return range(first, normalise(last), timeZone);
    }
    case 'year':
      return range(
        { year: today.year, month: 1, day: 1 },
        { year: today.year, month: 12, day: 31 },
        timeZone,
      );
    case 'custom': {
      const first = custom?.from ? parseCalendarDate(custom.from) : null;
      const last = custom?.to ? parseCalendarDate(custom.to) : null;
      if (first === null || last === null) return null;
      const span =
        Date.UTC(last.year, last.month - 1, last.day) -
        Date.UTC(first.year, first.month - 1, first.day);
      if (span < 0 || span > 3 * 366 * 86_400_000) return null;
      return range(first, last, timeZone);
    }
  }
}

function normalise(date: CalendarDate): CalendarDate {
  return addDays(date, 0);
}
