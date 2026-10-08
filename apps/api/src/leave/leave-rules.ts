/**
 * Leave's pure rules — DOCUMENT 16, OD-11 and OD-16 (approved for Phase 10).
 *
 * No database, no framework, no floating point: day counts and balances are
 * exact decimals at two places (`@ufuq/money`'s `Decimal`, DECIMAL(5,2) in
 * the schema). Every rule a balance depends on is here, once.
 */

import { Decimal } from '@ufuq/money';

import { dayFor, isHolidayOn } from '../attendance/schedule-context.js';
import type { ScheduleContext } from '../attendance/schedule-context.js';
import { compareDates, eachDay, formatCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';

/** DECIMAL(5,2) — DOCUMENT 06 §3.13, OD-11 ("already DECIMAL(5,2)"). */
export const DAYS_SCALE = 2;

export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type LeaveRequestStatusValue = (typeof LEAVE_REQUEST_STATUSES)[number];

export const CARRY_OVER_POLICIES = ['none', 'full', 'capped'] as const;
export type CarryOverPolicyValue = (typeof CARRY_OVER_POLICIES)[number];

/** DOCUMENT 16 validation: "Reason required, minimum 3 characters". */
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 1000;
export const NOTE_MAX_LENGTH = 1000;

/** Any database DECIMAL (Prisma's object or a string) as an exact two-place day count. */
export function days(value: { toString(): string } | string): Decimal {
  return Decimal.parse(typeof value === 'string' ? value : value.toString(), DAYS_SCALE);
}

export function daysToWire(value: Decimal): string {
  return value.toString();
}

// ---------------------------------------------------------------------------
// Rule 2 — duration from the employee's own schedule and the company holidays
// ---------------------------------------------------------------------------

/**
 * The days of `from`–`to` (inclusive) that are leave days: working days on
 * the employee's schedule that are not company holidays. Nothing about which
 * weekdays are weekends is known here — the schedule says (DOCUMENT 27
 * RULE 12). A schedule missing a weekday throws (`ScheduleIncompleteError`).
 */
export function leaveDates(
  context: ScheduleContext,
  workScheduleId: string,
  from: CalendarDate,
  to: CalendarDate,
): CalendarDate[] {
  return eachDay(from, to).filter(
    (date) => dayFor(context, date, workScheduleId).isWorkingDay && !isHolidayOn(context, date),
  );
}

/**
 * DOCUMENT 16 "Leave spanning two years: split at the year boundary; each
 * year's balance is charged its portion". Whole days (OD-11), by year, in
 * year order.
 */
export function allocateByYear(dates: readonly CalendarDate[]): Map<number, Decimal> {
  const counts = new Map<number, number>();
  for (const date of dates) {
    counts.set(date.year, (counts.get(date.year) ?? 0) + 1);
  }
  return new Map(
    [...counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, count]) => [year, Decimal.fromInteger(count, DAYS_SCALE)]),
  );
}

/** The stored form of an allocation: `{"2026": "3.00"}`. */
export function allocationToJson(allocation: ReadonlyMap<number, Decimal>): Record<string, string> {
  return Object.fromEntries(
    [...allocation].map(([year, value]) => [String(year), value.toString()]),
  );
}

export function allocationFromJson(value: unknown): Map<number, Decimal> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RangeError('year_allocation is not an object');
  }
  return new Map(
    Object.entries(value as Record<string, unknown>)
      .map(([year, amount]) => [Number(year), days(String(amount))] as const)
      .sort(([a], [b]) => a - b),
  );
}

export function sameAllocation(
  a: ReadonlyMap<number, Decimal>,
  b: ReadonlyMap<number, Decimal>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [year, value] of a) {
    const other = b.get(year);
    if (other === undefined || !other.equals(value)) return false;
  }
  return true;
}

export function totalDays(allocation: ReadonlyMap<number, Decimal>): Decimal {
  return Decimal.sum([...allocation.values()], DAYS_SCALE);
}

// ---------------------------------------------------------------------------
// OD-16 (approved, A) — pro-rating by month worked
// ---------------------------------------------------------------------------

/**
 * A year's allowance for an employee: the type's `default_days_per_year`
 * pro-rated by the months of that year the employee is employed.
 *
 * Approved Phase 10 rules: the **joining month counts in full** (joining on
 * any day of March gives 10 months — March to December), and the result is
 * **rounded half away from zero to two decimal places** (14 × 10 / 12 =
 * 11.666… → 11.67). A year before the joining year grants nothing; any later
 * year grants the full allowance.
 */
export function proratedAllowance(
  defaultDaysPerYear: Decimal,
  joiningDate: CalendarDate,
  year: number,
): Decimal {
  if (year < joiningDate.year) return Decimal.zero(DAYS_SCALE);
  if (year > joiningDate.year) return defaultDaysPerYear;
  const months = 12 - joiningDate.month + 1;
  return defaultDaysPerYear.multiplyByInteger(months).divideByInteger(12, 'nearest');
}

// ---------------------------------------------------------------------------
// The balance — DOCUMENT 16 "Remaining is computed, never stored"
// ---------------------------------------------------------------------------

export interface BalanceFigures {
  readonly totalDays: Decimal;
  readonly usedDays: Decimal;
  readonly pendingDays: Decimal;
  readonly carriedOverDays: Decimal;
}

/** `remaining = total_days + carried_over_days − used_days − pending_days`. */
export function remaining(balance: BalanceFigures): Decimal {
  return balance.totalDays
    .add(balance.carriedOverDays)
    .subtract(balance.usedDays)
    .subtract(balance.pendingDays);
}

/**
 * Rule 6: insufficient balance blocks the request, unless the type allows a
 * negative balance — in which case the excess is reported (treated as unpaid,
 * and the employee is warned before submitting). The requested days are
 * never truncated.
 */
export function balanceCheck(
  available: Decimal,
  requested: Decimal,
  allowsNegative: boolean,
): { readonly ok: boolean; readonly excess: Decimal } {
  const after = available.subtract(requested);
  const excess = after.isNegative() ? after.negate() : Decimal.zero(DAYS_SCALE);
  return { ok: excess.isZero() || allowsNegative, excess };
}

// ---------------------------------------------------------------------------
// Rule 13 — carry-over
// ---------------------------------------------------------------------------

/**
 * What a year's unused balance becomes in the next year. Only an unused,
 * positive remainder carries; `capped` keeps at most the cap, and the rest is
 * forfeited (DOCUMENT 16 "Carry-over exceeding the cap: excess is forfeited
 * and the forfeiture is recorded"). `none` carries nothing.
 */
export function carryOver(
  policy: CarryOverPolicyValue,
  cap: Decimal | null,
  unused: Decimal,
): { readonly carried: Decimal; readonly forfeited: Decimal } {
  const zero = Decimal.zero(DAYS_SCALE);
  const positive = unused.isNegative() ? zero : unused;
  if (policy === 'none') return { carried: zero, forfeited: zero };
  if (policy === 'full') return { carried: positive, forfeited: zero };
  const limit = cap ?? zero;
  const carried = positive.compare(limit) > 0 ? limit : positive;
  return { carried, forfeited: positive.subtract(carried) };
}

/** `[from, to]` overlaps `[start, end]` (inclusive calendar ranges). */
export function rangesOverlap(
  from: CalendarDate,
  to: CalendarDate,
  start: CalendarDate,
  end: CalendarDate,
): boolean {
  return compareDates(from, end) <= 0 && compareDates(start, to) <= 0;
}

export function dateKey(date: CalendarDate): string {
  return formatCalendarDate(date);
}
