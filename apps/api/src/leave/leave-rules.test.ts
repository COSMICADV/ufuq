/**
 * Leave's pure rules — DOCUMENT 16, OD-11, OD-16 — without a database.
 */

import { Decimal } from '@ufuq/money';
import { describe, expect, it } from 'vitest';

import type { ScheduleContext } from '../attendance/schedule-context.js';
import { ScheduleIncompleteError } from '../attendance/schedule-context.js';
import { parseCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';

import {
  allocateByYear,
  allocationFromJson,
  allocationToJson,
  balanceCheck,
  carryOver,
  dateKey,
  days,
  leaveDates,
  proratedAllowance,
  rangesOverlap,
  remaining,
  sameAllocation,
  totalDays,
} from './leave-rules.js';

function d(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (parsed === null) throw new Error(value);
  return parsed;
}

/** A schedule as data: which weekdays (0 = Sunday) work. */
function schedule(working: readonly number[], holidays: readonly string[] = []): ScheduleContext {
  const dayRows = new Map(
    Array.from({ length: 7 }, (_, dow) => [
      dow,
      working.includes(dow)
        ? { isWorkingDay: true, startMinutes: 540, endMinutes: 1020 }
        : { isWorkingDay: false, startMinutes: null, endMinutes: null },
    ]),
  );
  return {
    settings: {
      timezone: 'Africa/Cairo',
      gracePeriodMinutes: 15,
      breakMinutes: 60,
      halfDayThresholdHours: 4,
      overtimePolicy: 'paid',
    },
    days: dayRows,
    holidays: new Set(holidays),
  };
}

const SUN_THU = schedule([0, 1, 2, 3, 4]);

describe('rule 2 — duration from the schedule and holidays', () => {
  it('counts the employee’s working days, never a hardcoded weekend', () => {
    // Sun 2026-03-08 … Sat 2026-03-14: Sunday–Thursday work.
    const dates = leaveDates(SUN_THU, 's', d('2026-03-08'), d('2026-03-14'));
    expect(dates.map(dateKey)).toEqual([
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
    // The same week on a Monday–Friday schedule counts different days.
    const monFri = schedule([1, 2, 3, 4, 5]);
    expect(leaveDates(monFri, 's', d('2026-03-08'), d('2026-03-14')).map(dateKey)).toEqual([
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  it('excludes company holidays', () => {
    const withHoliday = schedule([0, 1, 2, 3, 4], ['2026-03-10']);
    expect(leaveDates(withHoliday, 's', d('2026-03-08'), d('2026-03-12'))).toHaveLength(4);
  });

  it('an all-rest-day range has no leave days', () => {
    expect(leaveDates(SUN_THU, 's', d('2026-03-13'), d('2026-03-14'))).toEqual([]);
  });

  it('refuses to guess a weekday the schedule does not define', () => {
    const broken = SUN_THU.days as Map<number, unknown>;
    const incomplete: ScheduleContext = {
      ...SUN_THU,
      days: new Map([...broken].filter(([dow]) => dow !== 3)) as ScheduleContext['days'],
    };
    expect(() => leaveDates(incomplete, 's', d('2026-03-08'), d('2026-03-14'))).toThrow(
      ScheduleIncompleteError,
    );
  });

  it('a range across months keeps every day on its own date', () => {
    const dates = leaveDates(SUN_THU, 's', d('2026-03-29'), d('2026-04-02'));
    expect(dates.map(dateKey)).toEqual([
      '2026-03-29',
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ]);
  });
});

describe('two years — each year is charged its own portion', () => {
  it('splits at the year boundary, whole days (OD-11)', () => {
    const dates = leaveDates(SUN_THU, 's', d('2026-12-29'), d('2027-01-05'));
    const allocation = allocateByYear(dates);
    expect(allocationToJson(allocation)).toEqual({ '2026': '3.00', '2027': '3.00' });
    expect(totalDays(allocation).toString()).toBe('6.00');
    expect(sameAllocation(allocationFromJson({ '2027': '3.00', '2026': '3.00' }), allocation)).toBe(
      true,
    );
    expect(sameAllocation(allocationFromJson({ '2026': '4.00', '2027': '2.00' }), allocation)).toBe(
      false,
    );
  });
});

describe('OD-16 (approved) — pro-rated by month worked', () => {
  const annual = days('14');

  it('the joining month counts in full; the result rounds half away from zero to 2 places', () => {
    // Joining any day of March: 10 months. 14 × 10 / 12 = 11.666… → 11.67.
    expect(proratedAllowance(annual, d('2026-03-01'), 2026).toString()).toBe('11.67');
    expect(proratedAllowance(annual, d('2026-03-31'), 2026).toString()).toBe('11.67');
    // September: 4 months. 14 × 4 / 12 = 4.666… → 4.67.
    expect(proratedAllowance(annual, d('2026-09-15'), 2026).toString()).toBe('4.67');
    // 21 × 6 / 12 = 10.5 exactly.
    expect(proratedAllowance(days('21'), d('2026-07-20'), 2026).toString()).toBe('10.50');
    // December: one month. 21 / 12 = 1.75 exactly.
    expect(proratedAllowance(days('21'), d('2026-12-31'), 2026).toString()).toBe('1.75');
  });

  it('a January joiner gets the whole allowance; later years too; earlier years nothing', () => {
    expect(proratedAllowance(annual, d('2026-01-20'), 2026).toString()).toBe('14.00');
    expect(proratedAllowance(annual, d('2025-09-01'), 2026).toString()).toBe('14.00');
    expect(proratedAllowance(annual, d('2027-01-01'), 2026).toString()).toBe('0.00');
  });

  it('uses the type’s allowance, whatever it is — a zero allowance stays zero', () => {
    expect(proratedAllowance(days('0'), d('2026-03-01'), 2026).toString()).toBe('0.00');
    expect(proratedAllowance(days('30'), d('2026-04-01'), 2026).toString()).toBe('22.50');
  });
});

describe('the balance', () => {
  it('remaining = total + carried − used − pending, exactly', () => {
    const balance = {
      totalDays: days('14'),
      carriedOverDays: days('2.5'),
      usedDays: days('6'),
      pendingDays: days('3'),
    };
    expect(remaining(balance).toString()).toBe('7.50');
    // The classic float trap is exact here.
    expect(
      remaining({
        totalDays: days('0.1'),
        carriedOverDays: days('0.2'),
        usedDays: days('0'),
        pendingDays: days('0'),
      }).toString(),
    ).toBe('0.30');
  });

  it('insufficient balance blocks unless the type allows negative; the excess is reported', () => {
    expect(balanceCheck(days('3'), days('5'), false)).toMatchObject({ ok: false });
    const allowed = balanceCheck(days('3'), days('5'), true);
    expect(allowed.ok).toBe(true);
    expect(allowed.excess.toString()).toBe('2.00');
    const enough = balanceCheck(days('5'), days('5'), false);
    expect(enough.ok).toBe(true);
    expect(enough.excess.isZero()).toBe(true);
  });
});

describe('rule 13 — carry-over', () => {
  it('none carries nothing; full carries the unused remainder', () => {
    expect(carryOver('none', null, days('4')).carried.toString()).toBe('0.00');
    expect(carryOver('full', null, days('4')).carried.toString()).toBe('4.00');
  });

  it('capped keeps at most the cap and forfeits the excess', () => {
    const capped = carryOver('capped', days('5'), days('8.5'));
    expect(capped.carried.toString()).toBe('5.00');
    expect(capped.forfeited.toString()).toBe('3.50');
    const under = carryOver('capped', days('5'), days('2'));
    expect(under.carried.toString()).toBe('2.00');
    expect(under.forfeited.isZero()).toBe(true);
  });

  it('a negative or zero remainder carries and forfeits nothing', () => {
    for (const policy of ['full', 'capped'] as const) {
      const result = carryOver(policy, days('5'), days('-2'));
      expect(result.carried.isZero()).toBe(true);
      expect(result.forfeited.isZero()).toBe(true);
    }
  });
});

describe('overlap', () => {
  it('inclusive ranges overlap when they share a day', () => {
    expect(rangesOverlap(d('2026-03-10'), d('2026-03-12'), d('2026-03-12'), d('2026-03-15'))).toBe(
      true,
    );
    expect(rangesOverlap(d('2026-03-10'), d('2026-03-12'), d('2026-03-13'), d('2026-03-15'))).toBe(
      false,
    );
  });
});

describe('exact decimals', () => {
  it('reads Prisma-style decimals exactly', () => {
    expect(days({ toString: () => '14' }).toString()).toBe('14.00');
    expect(days('11.67').add(Decimal.parse('0.33', 2)).toString()).toBe('12.00');
  });
});
