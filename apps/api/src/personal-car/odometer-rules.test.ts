import { describe, expect, it } from 'vitest';

import { checkReading, drivingStats, formatTenths, predictDateForKm } from './odometer-rules.js';
import type { Reading } from './odometer-rules.js';

const day = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 86_400_000);
const r = (id: string, km: number, d: number, segment = 1, kind: Reading['kind'] = 'normal'): Reading => ({
  id,
  km,
  at: day(d),
  segment,
  kind,
});

describe('checkReading', () => {
  const history = [r('a', 10_000, 0), r('b', 10_400, 10), r('c', 11_000, 20)];
  it('accepts a reading after the last one, and one fitting between two', () => {
    expect(checkReading(history, { km: 11_300, at: day(25), kind: 'normal' })).toEqual({ ok: true, segment: 1 });
    expect(checkReading(history, { km: 10_700, at: day(15), kind: 'normal' })).toEqual({ ok: true, segment: 1 });
  });
  it('refuses a reading below the one before or above the one after', () => {
    expect(checkReading(history, { km: 10_900, at: day(25), kind: 'normal' })).toMatchObject({ ok: false, problem: 'decreasing' });
    expect(checkReading(history, { km: 11_200, at: day(15), kind: 'normal' })).toMatchObject({ ok: false, problem: 'exceeds_next' });
  });
  it('flags an unusual jump until the person confirms it', () => {
    expect(checkReading(history, { km: 30_000, at: day(21), kind: 'normal' })).toMatchObject({ ok: false, problem: 'unusual' });
    expect(checkReading(history, { km: 30_000, at: day(21), kind: 'normal' }, true)).toEqual({ ok: true, segment: 1 });
    expect(checkReading(history, { km: 80_000, at: day(200), kind: 'normal' })).toMatchObject({ problem: 'unusual' });
  });
  it('starts a new segment on a reset or replacement, only as the latest reading', () => {
    expect(checkReading(history, { km: 0, at: day(30), kind: 'reset' })).toEqual({ ok: true, segment: 2 });
    expect(checkReading(history, { km: 5, at: day(5), kind: 'replacement' })).toMatchObject({ ok: false, problem: 'reset_not_latest' });
    const after = [...history, r('d', 0, 30, 2, 'reset')];
    expect(checkReading(after, { km: 350, at: day(35), kind: 'normal' })).toEqual({ ok: true, segment: 2 });
  });
  it('checks an edit against the others, not against itself', () => {
    expect(checkReading(history, { km: 10_500, at: day(10), kind: 'normal', excludeId: 'b' })).toEqual({ ok: true, segment: 1 });
  });
});

describe('drivingStats', () => {
  const now = day(30);
  it('says what is missing before averaging', () => {
    expect(drivingStats([], now)).toMatchObject({ status: 'insufficient', reason: 'no_readings', current: null });
    expect(drivingStats([r('a', 1000, 0), r('b', 1100, 10)], now)).toMatchObject({ reason: 'need_readings' });
    expect(drivingStats([r('a', 1000, 0), r('b', 1050, 2), r('c', 1100, 4)], now)).toMatchObject({ reason: 'need_days' });
  });
  it('averages real differences over real time', () => {
    const s = drivingStats([r('a', 10_000, 0), r('b', 10_400, 10), r('c', 11_000, 20)], now);
    expect(s).toMatchObject({ status: 'ok', dailyTenths: 500, monthlyKm: 1522, readingsUsed: 3, spanDays: 20, current: { km: 11_000 } });
    expect(formatTenths(s.dailyTenths ?? 0)).toBe('50.0');
    expect(s.trend).toEqual({ recentDailyTenths: 600, direction: 'up' });
  });
  it('measures only the latest segment after a reset', () => {
    const s = drivingStats([r('a', 90_000, 0), r('b', 91_000, 5), r('c', 0, 10, 2, 'reset'), r('d', 300, 20, 2), r('e', 600, 30, 2)], day(31));
    expect(s).toMatchObject({ segment: 2, status: 'ok', dailyTenths: 300, readingsUsed: 3 });
  });
  it('marks a stale odometer and unusual readings', () => {
    const s = drivingStats([r('a', 1000, 0), r('b', 1100, 7), r('c', 9000, 8)], day(30));
    expect(s.stale).toBe(true);
    expect(s.daysSinceLast).toBe(22);
    expect(s.unusual).toEqual(['c']);
  });
});

describe('predictDateForKm', () => {
  it('extrapolates at the average, and says nothing without one', () => {
    expect(predictDateForKm({ km: 11_000, at: day(20) }, 12_000, 500)?.toISOString()).toBe(day(40).toISOString());
    expect(predictDateForKm({ km: 11_000, at: day(20) }, 10_500, 500)?.toISOString()).toBe(day(20).toISOString());
    expect(predictDateForKm({ km: 11_000, at: day(20) }, 12_000, null)).toBeNull();
  });
});
