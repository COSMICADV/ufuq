/**
 * Budgets — the arithmetic, kept pure so every rule is tested on its own.
 *
 * Nothing here stores what was spent: the service sums it from the
 * transactions and hands the totals in. Money is decimal throughout.
 */

import { Decimal } from '@ufuq/money';

const SCALE = 2;
export const ALERT_CHOICES = [50, 60, 70, 75, 80, 85, 90, 95, 100] as const;
export const DEFAULT_ALERTS = [80, 90, 100] as const;
/** How far back a monthly budget's history (and its rollover) is followed. */
export const HISTORY_MONTHS = 24;

export interface Month {
  readonly year: number;
  readonly month: number;
}

export function parseMonth(value: string): Month | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  const year = Number(match[1]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { year, month };
}

export function formatMonth(m: Month): string {
  return `${String(m.year)}-${String(m.month).padStart(2, '0')}`;
}

export function addMonths(m: Month, by: number): Month {
  const index = m.year * 12 + (m.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function compareMonths(a: Month, b: Month): number {
  return a.year * 12 + a.month - (b.year * 12 + b.month);
}

/**
 * The months a monthly budget has run, oldest first, from its first month to
 * `until` — at most {@link HISTORY_MONTHS} (older ones fall out of rollover).
 */
export function monthsBetween(start: Month, until: Month): Month[] {
  if (compareMonths(until, start) < 0) return [];
  const count = Math.min(compareMonths(until, start) + 1, HISTORY_MONTHS);
  const first = addMonths(until, -(count - 1));
  return Array.from({ length: count }, (_, i) => addMonths(first, i));
}

export interface MonthResult {
  readonly month: string;
  /** This month's limit: the budget amount plus what was carried in. */
  readonly limit: string;
  readonly carried: string;
  readonly spent: string;
  readonly remaining: string;
}

/**
 * Each month's limit and remainder. With rollover, the remainder of one month
 * (positive when money was left, negative when it was overspent) is added to
 * the next month's limit; without it, every month starts from the amount.
 */
export function monthlyResults(
  amount: string,
  months: readonly { readonly month: string; readonly spent: string }[],
  rollover: boolean,
): MonthResult[] {
  const base = Decimal.parse(amount, SCALE);
  let carried = Decimal.zero(SCALE);
  return months.map(({ month, spent }) => {
    const used = Decimal.parse(spent, SCALE);
    const limit = base.add(carried);
    const remaining = limit.subtract(used);
    const result = {
      month,
      limit: limit.toString(),
      carried: carried.toString(),
      spent: used.toString(),
      remaining: remaining.toString(),
    };
    carried = rollover ? remaining : Decimal.zero(SCALE);
    return result;
  });
}

export interface BudgetStatus {
  /** Whole percent of the limit used (floored); 100+ when it is reached. */
  readonly percent: number;
  /** The highest alert threshold reached, or null. */
  readonly level: number | null;
  readonly state: 'ok' | 'warning' | 'reached' | 'over';
}

/**
 * Where spending stands against a limit. A limit that rollover has pushed to
 * zero or below is "over" as soon as anything is spent.
 */
export function budgetStatus(spent: string, limit: string, thresholds: readonly number[]): BudgetStatus {
  const used = Decimal.parse(spent, SCALE);
  const cap = Decimal.parse(limit, SCALE);
  if (!cap.isPositive()) {
    const over = used.isPositive() || cap.isNegative();
    return { percent: over ? 100 : 0, level: over ? 100 : null, state: over ? 'over' : 'ok' };
  }
  const percent = Number(used.multiplyByInteger(100).divide(cap, 'down').rescale(0, 'down').toString());
  const reached = [...thresholds].sort((a, b) => a - b).filter((t) => percent >= t);
  const level = reached.length > 0 ? (reached[reached.length - 1] ?? null) : null;
  const over = used.compare(cap) > 0;
  const state = over ? 'over' : percent >= 100 ? 'reached' : level !== null ? 'warning' : 'ok';
  return { percent, level, state };
}

/** Thresholds as stored: known choices only, unique, ascending. */
export function normaliseThresholds(values: readonly number[]): number[] {
  const known = new Set<number>(ALERT_CHOICES);
  return [...new Set(values.filter((v) => known.has(v)))].sort((a, b) => a - b);
}
