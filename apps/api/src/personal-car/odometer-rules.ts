/**
 * My Car — odometer arithmetic, kept pure so each rule is tested on its own.
 *
 * Distances are integer kilometres; an average is held in whole tenths of a
 * kilometre per day, so no floating-point value is ever stored or compared.
 * Every figure comes from confirmed readings: nothing is invented or
 * interpolated, and a reading never counts across a reset or a replaced
 * odometer (`segment`).
 */

const DAY_MS = 86_400_000;
/** Readings needed, and days they must span, before averages are shown. */
export const MIN_READINGS = 3;
export const MIN_SPAN_DAYS = 7;
/** Averages use the latest readings of this window when it holds enough. */
export const WINDOW_DAYS = 180;
/** Faster than this between two readings is flagged as unusual. */
export const UNUSUAL_KM_PER_DAY = 1500;
/** A jump this large in one step is unusual whatever the time between. */
export const UNUSUAL_JUMP_KM = 50_000;
/** Days without a reading after which a fresh photo is suggested. */
export const STALE_DAYS = 15;

export interface Reading {
  readonly id: string;
  readonly km: number;
  readonly at: Date;
  readonly segment: number;
  readonly kind: 'normal' | 'reset' | 'replacement';
}

export type ReadingProblem =
  | 'decreasing'
  | 'exceeds_next'
  | 'reset_not_latest'
  | 'unusual';

/** Oldest first; for one instant, the earlier segment first. */
export function sortReadings(readings: readonly Reading[]): Reading[] {
  return [...readings].sort((a, b) => a.at.getTime() - b.at.getTime() || a.segment - b.segment);
}

/**
 * Whether a new (or edited) reading fits the vehicle's history, and which
 * segment it belongs to. A reset or replacement may only be the latest
 * reading, and begins a new segment. A normal reading must not be below the
 * reading before it or above the reading after it in its segment. A big
 * jump is `unusual`: allowed only once the person confirms it.
 */
export function checkReading(
  history: readonly Reading[],
  candidate: { km: number; at: Date; kind: Reading['kind']; excludeId?: string | null },
  confirmedUnusual = false,
): { ok: true; segment: number } | { ok: false; problem: ReadingProblem; segment: number } {
  const others = sortReadings(history.filter((r) => r.id !== candidate.excludeId));
  const before = others.filter((r) => r.at.getTime() <= candidate.at.getTime());
  const after = others.filter((r) => r.at.getTime() > candidate.at.getTime());
  const previous = before[before.length - 1] ?? null;
  const lastSegment = others.length > 0 ? Math.max(...others.map((r) => r.segment)) : 1;

  if (candidate.kind !== 'normal') {
    if (after.length > 0) return { ok: false, problem: 'reset_not_latest', segment: lastSegment };
    return { ok: true, segment: others.length === 0 ? 1 : lastSegment + 1 };
  }

  const segment = previous?.segment ?? after[0]?.segment ?? 1;
  const next = after.find((r) => r.segment === segment && r.kind === 'normal') ?? null;
  if (previous && previous.segment === segment && candidate.km < previous.km) {
    return { ok: false, problem: 'decreasing', segment };
  }
  if (next && candidate.km > next.km) return { ok: false, problem: 'exceeds_next', segment };
  if (!confirmedUnusual && previous && previous.segment === segment) {
    const km = candidate.km - previous.km;
    const days = (candidate.at.getTime() - previous.at.getTime()) / DAY_MS;
    if (km > UNUSUAL_JUMP_KM || (days > 0 && km / Math.max(days, 1) > UNUSUAL_KM_PER_DAY) || (days <= 0 && km > UNUSUAL_KM_PER_DAY)) {
      return { ok: false, problem: 'unusual', segment };
    }
  }
  return { ok: true, segment };
}

export interface DrivingStats {
  readonly current: { readonly km: number; readonly at: Date } | null;
  readonly segment: number;
  readonly status: 'ok' | 'insufficient';
  readonly reason: 'no_readings' | 'need_readings' | 'need_days' | null;
  /** Average km per day, in tenths (e.g. 423 = 42.3 km/day). */
  readonly dailyTenths: number | null;
  /** Estimated km per month (30.44 days), whole km. */
  readonly monthlyKm: number | null;
  readonly readingsUsed: number;
  readonly spanDays: number;
  /** The latest stretch compared with the average: driving more, less, or the same. */
  readonly trend: { readonly recentDailyTenths: number; readonly direction: 'up' | 'down' | 'steady' } | null;
  /** Readings that imply driving faster than {@link UNUSUAL_KM_PER_DAY}. */
  readonly unusual: readonly string[];
  readonly daysSinceLast: number | null;
  readonly stale: boolean;
}

function tenthsPerDay(km: number, ms: number): number {
  // Floor of km×10 per day, in integers: km × 10 × DAY_MS / ms.
  return Math.floor((km * 10 * DAY_MS) / ms);
}

export function drivingStats(readings: readonly Reading[], now: Date): DrivingStats {
  const sorted = sortReadings(readings);
  const last = sorted[sorted.length - 1] ?? null;
  const daysSinceLast = last ? Math.floor((now.getTime() - last.at.getTime()) / DAY_MS) : null;
  const base = {
    current: last ? { km: last.km, at: last.at } : null,
    segment: last?.segment ?? 1,
    daysSinceLast,
    stale: daysSinceLast !== null && daysSinceLast >= STALE_DAYS,
  };
  const segment = sorted.filter((r) => r.segment === base.segment);

  const unusual: string[] = [];
  for (let i = 1; i < segment.length; i += 1) {
    const a = segment[i - 1];
    const b = segment[i];
    if (!a || !b) continue;
    const ms = Math.max(b.at.getTime() - a.at.getTime(), DAY_MS);
    if (b.km - a.km > UNUSUAL_JUMP_KM || tenthsPerDay(b.km - a.km, ms) > UNUSUAL_KM_PER_DAY * 10) unusual.push(b.id);
  }

  const empty = { dailyTenths: null, monthlyKm: null, trend: null, unusual };
  if (segment.length === 0) {
    return { ...base, ...empty, status: 'insufficient', reason: 'no_readings', readingsUsed: 0, spanDays: 0 };
  }
  const windowStart = (last?.at.getTime() ?? 0) - WINDOW_DAYS * DAY_MS;
  const recent = segment.filter((r) => r.at.getTime() >= windowStart);
  const used = recent.length >= MIN_READINGS ? recent : segment;
  const first = used[0];
  const end = used[used.length - 1];
  const spanMs = first && end ? end.at.getTime() - first.at.getTime() : 0;
  const spanDays = Math.floor(spanMs / DAY_MS);
  if (used.length < MIN_READINGS) {
    return { ...base, ...empty, status: 'insufficient', reason: 'need_readings', readingsUsed: used.length, spanDays };
  }
  if (spanDays < MIN_SPAN_DAYS || !first || !end) {
    return { ...base, ...empty, status: 'insufficient', reason: 'need_days', readingsUsed: used.length, spanDays };
  }
  const dailyTenths = tenthsPerDay(end.km - first.km, spanMs);
  // 30.44 days a month: tenths × 3044 / 1000 = km per month.
  const monthlyKm = Math.floor((dailyTenths * 3044) / 1000);

  // The latest stretch of at least MIN_SPAN_DAYS, against the average.
  let trend: DrivingStats['trend'] = null;
  for (let i = used.length - 2; i >= 0; i -= 1) {
    const start = used[i];
    if (!start) continue;
    const ms = end.at.getTime() - start.at.getTime();
    if (ms >= MIN_SPAN_DAYS * DAY_MS) {
      if (start !== first) {
        const recentDailyTenths = tenthsPerDay(end.km - start.km, ms);
        const diff = recentDailyTenths - dailyTenths;
        // ±15 % of the average counts as steady.
        const direction = Math.abs(diff) * 100 <= dailyTenths * 15 ? 'steady' : diff > 0 ? 'up' : 'down';
        trend = { recentDailyTenths, direction };
      }
      break;
    }
  }

  return {
    ...base,
    status: 'ok',
    reason: null,
    dailyTenths,
    monthlyKm,
    readingsUsed: used.length,
    spanDays,
    trend,
    unusual,
  };
}

/**
 * When the vehicle should reach `targetKm`, at its observed average — an
 * estimate, null when there is no average or no driving to extrapolate.
 */
export function predictDateForKm(
  current: { km: number; at: Date },
  targetKm: number,
  dailyTenths: number | null,
): Date | null {
  if (dailyTenths === null || dailyTenths <= 0) return null;
  const remaining = targetKm - current.km;
  if (remaining <= 0) return current.at;
  const days = Math.ceil((remaining * 10) / dailyTenths);
  return new Date(current.at.getTime() + days * DAY_MS);
}

/** "42.3" from 423 tenths — for display and payloads, never for arithmetic. */
export function formatTenths(tenths: number): string {
  return `${String(Math.floor(tenths / 10))}.${String(tenths % 10)}`;
}
