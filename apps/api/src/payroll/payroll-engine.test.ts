/**
 * The payroll engine against its configuration — DOCUMENT 15, DOCUMENT 26
 * "Unit" rows for daily wage, attendance adjustment, net salary and working
 * days, and the Phase 11 approved decisions.
 *
 * Every monetary assertion is an exact decimal string (DOCUMENT 26: "A test
 * that passes with floating-point tolerance is testing the wrong thing").
 * Calendars used: March 2026 starts on a Sunday and has 31 days; with a
 * Sunday–Thursday week it has 23 working days. February 2026 has 28 days,
 * February 2028 has 29, April 2026 has 30.
 */

import { describe, expect, it } from 'vitest';

import type { CalendarDate } from '../attendance/zoned-time.js';

import { Fraction } from './fraction.js';
import { calculatePayrollLine, PayrollEngineError, renet, roundNet } from './payroll-engine.js';
import type { DayInput, DayRecord, EngineInput, PolicyConfig } from './payroll-engine.js';

const SUN_THU = new Set([0, 1, 2, 3, 4]);
const MINUTES = 420; // 09:00–17:00 less a 60-minute break

function date(value: string): CalendarDate {
  const [y, m, d] = value.split('-').map((part) => Number.parseInt(part, 10));
  return { year: y as number, month: m as number, day: d as number };
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const present = (o: Partial<DayRecord> = {}): DayRecord => ({
  status: 'present',
  hasCheckIn: true,
  workMode: 'office',
  lateMinutes: 0,
  overtimeMinutes: 0,
  leavePaid: null,
  ...o,
});

const absent: DayRecord = {
  status: 'absent',
  hasCheckIn: false,
  workMode: null,
  lateMinutes: 0,
  overtimeMinutes: 0,
  leavePaid: null,
};

const leave = (paid: boolean): DayRecord => ({ ...absent, status: 'on_leave', leavePaid: paid });

interface MonthOptions {
  readonly year?: number;
  readonly month?: number;
  readonly week?: ReadonlySet<number>;
  readonly holidays?: readonly string[];
  /** Records by `YYYY-MM-DD`; any other working day is present. */
  readonly records?: Readonly<Record<string, DayRecord | null>>;
}

function month(options: MonthOptions = {}): DayInput[] {
  const year = options.year ?? 2026;
  const m = options.month ?? 3;
  const week = options.week ?? SUN_THU;
  const holidays = new Set(options.holidays ?? []);
  return Array.from({ length: daysIn(year, m) }, (_, index) => {
    const d: CalendarDate = { year, month: m, day: index + 1 };
    const key = `${String(year)}-${String(m).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
    const weekday = new Date(Date.UTC(year, m - 1, index + 1)).getUTCDay();
    const scheduledWorking = week.has(weekday);
    const isHoliday = holidays.has(key);
    const record =
      options.records !== undefined && key in options.records
        ? (options.records[key] ?? null)
        : scheduledWorking && !isHoliday
          ? present()
          : null;
    return {
      date: d,
      scheduledWorking,
      isHoliday,
      scheduledMinutes: scheduledWorking ? MINUTES : 0,
      record,
    };
  });
}

const POLICY: PolicyConfig = {
  dailyWageBasis: 'fixed_days',
  fixedDaysValue: 30,
  unpaidLeaveDeduction: 'daily_wage',
  absenceDeduction: 'daily_wage',
  latenessRule: { type: 'none' },
  overtimeRate: '0.00',
  rounding: 'none',
};

function line(
  overrides: Partial<Omit<EngineInput, 'policy'>> & { policy?: Partial<PolicyConfig> } = {},
) {
  const { policy, ...rest } = overrides;
  const year = rest.year ?? 2026;
  const m = rest.month ?? 3;
  return calculatePayrollLine({
    year,
    month: m,
    policy: { ...POLICY, ...policy },
    overtimePaid: false,
    joiningDate: date('2025-01-01'),
    terminationDate: null,
    salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '20000.00' }],
    days: month({ year, month: m }),
    deductions: [],
    bonuses: [],
    ...rest,
  });
}

describe('Fraction — exact until the one rounding', () => {
  it('parses decimals, keeps exact values through JSON, and rounds each way', () => {
    const third = Fraction.parse('100.00').divideByInteger(3);
    expect(Fraction.fromJSON(third.toJSON()).compare(third)).toBe(0);
    expect(third.toDecimal(2, 'nearest').toString()).toBe('33.33');
    expect(third.toDecimal(2, 'up').toString()).toBe('33.34');
    expect(third.toDecimal(2, 'down').toString()).toBe('33.33');
    expect(third.negate().toDecimal(2, 'down').toString()).toBe('-33.34');
    expect(Fraction.parse('2.50').toDecimal(0, 'nearest').toString()).toBe('3');
    expect(Fraction.parse('-2.50').toDecimal(0, 'nearest').toString()).toBe('-3');
    expect(() => third.toDecimal(2, 'exact')).toThrow(/not exact/);
  });
});

describe('daily wage — all three bases, months of 28, 29, 30 and 31 days', () => {
  const cases: [number, number, string, string][] = [
    // year, month, calendar_days wage, scheduled_working_days wage
    [2026, 2, '714.29', '1000.00'], // 28 days, 20 working days
    [2028, 2, '689.66', '952.38'], // 29 days (leap), 21 working days
    [2026, 4, '666.67', '909.09'], // 30 days, 22 working days
    [2026, 3, '645.16', '869.57'], // 31 days, 23 working days
  ];

  for (const [year, m, calendar, scheduled] of cases) {
    it(`${String(year)}-${String(m)}: fixed 30 / calendar / scheduled`, () => {
      const days = month({ year, month: m });
      const fixed = line({ year, month: m, days });
      expect(fixed.dailyWage.toString()).toBe('666.67');
      expect(fixed.calendarDaysInMonth).toBe(daysIn(year, m));
      expect(
        line({
          year,
          month: m,
          days,
          policy: { dailyWageBasis: 'calendar_days', fixedDaysValue: null },
        }).dailyWage.toString(),
      ).toBe(calendar);
      expect(
        line({
          year,
          month: m,
          days,
          policy: { dailyWageBasis: 'scheduled_working_days', fixedDaysValue: null },
        }).dailyWage.toString(),
      ).toBe(scheduled);
      // A full month with full attendance is the full salary, whatever the basis.
      expect(fixed.netSalary.toString()).toBe('20000.00');
    });
  }

  it('fixed 26 gives 769.23 shown, while the exact wage is kept for the arithmetic', () => {
    const result = line({ policy: { fixedDaysValue: 26 } });
    expect(result.dailyWage.toString()).toBe('769.23');
    expect(result.segments[0]?.dailyWage.toJSON()).toBe('10000/13');
  });
});

describe('working days — schedule, holidays, joining and termination', () => {
  it('counts the schedule’s working days, minus holidays, and never charges a holiday', () => {
    const days = month({ holidays: ['2026-03-19'] });
    const result = line({ days });
    expect(result.workingDaysInMonth).toBe(22);
    expect(result.counts.workingDays).toBe(22);
    expect(result.counts.absentDays).toBe(0);
    expect(result.netSalary.toString()).toBe('20000.00');
  });

  it('follows a custom schedule rather than a built-in week', () => {
    const sixDays = new Set([0, 1, 2, 3, 4, 6]);
    const result = line({
      days: month({ week: sixDays }),
      policy: { dailyWageBasis: 'scheduled_working_days', fixedDaysValue: null },
    });
    expect(result.workingDaysInMonth).toBe(27);
    expect(result.dailyWage.toString()).toBe('740.74');
  });

  it('a mid-month joiner is paid the working-day share from the joining date', () => {
    // Joins Monday 16 March: 12 of the month's 23 working days.
    const result = line({ joiningDate: date('2026-03-16') });
    expect(result.employedFrom).toBe('2026-03-16');
    expect(result.counts.workingDays).toBe(12);
    expect(result.exact.base.toJSON()).toBe('240000/23');
    expect(result.baseSalary.toString()).toBe('10434.78');
    expect(result.netSalary.toString()).toBe('10434.78');
  });

  it('a mid-month leaver is paid to the termination date (no settlement — OD-08)', () => {
    // Terminated Tuesday 10 March: 8 working days.
    const result = line({ terminationDate: date('2026-03-10') });
    expect(result.employedTo).toBe('2026-03-10');
    expect(result.counts.workingDays).toBe(8);
    expect(result.baseSalary.toString()).toBe('6956.52');
  });

  it('refuses an employee not employed in the month, and a month with no working day', () => {
    expect(() => line({ joiningDate: date('2026-04-01') })).toThrow(PayrollEngineError);
    const allHolidays = month({
      holidays: Array.from({ length: 31 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`),
    });
    expect(() => line({ days: allHolidays })).toThrow(/no_working_days_in_month/);
  });
});

describe('salary history — every effective portion, calculated and summed', () => {
  it('one salary row covering the month', () => {
    expect(line().segments).toHaveLength(1);
  });

  it('a mid-month change: 11 days at 20,000 and 12 at 26,000', () => {
    const result = line({
      salaries: [
        { from: date('2025-01-01'), to: date('2026-03-15'), monthlySalary: '20000.00' },
        { from: date('2026-03-16'), to: null, monthlySalary: '26000.00' },
      ],
    });
    expect(result.segments.map((s) => [s.from, s.to, s.workingDays])).toEqual([
      ['2026-03-01', '2026-03-15', 11],
      ['2026-03-16', '2026-03-31', 12],
    ]);
    // (20000 × 11 + 26000 × 12) ÷ 23 = 532000 / 23, rounded once.
    expect(result.exact.base.toJSON()).toBe('532000/23');
    expect(result.baseSalary.toString()).toBe('23130.43');
    expect(result.netSalary.toString()).toBe('23130.43');
    // The shown daily wage is the latest portion's; each portion priced its own days.
    expect(result.dailyWage.toString()).toBe('866.67');
  });

  it('prices an absence at the salary effective on that day', () => {
    const records = { '2026-03-02': absent, '2026-03-17': absent };
    const result = line({
      days: month({ records }),
      salaries: [
        { from: date('2025-01-01'), to: date('2026-03-15'), monthlySalary: '20000.00' },
        { from: date('2026-03-16'), to: null, monthlySalary: '26000.00' },
      ],
    });
    // 20000/30 + 26000/30 = 46000/30
    expect(result.exact.absence.toJSON()).toBe('4600/3');
  });

  it('the effective-date boundary belongs to the new row', () => {
    const result = line({
      salaries: [
        { from: date('2025-01-01'), to: date('2026-02-28'), monthlySalary: '20000.00' },
        { from: date('2026-03-01'), to: null, monthlySalary: '23000.00' },
      ],
    });
    expect(result.segments).toHaveLength(1);
    expect(result.baseSalary.toString()).toBe('23000.00');
  });

  it('a day no salary row covers is refused, never guessed', () => {
    expect(() =>
      line({ salaries: [{ from: date('2026-03-05'), to: null, monthlySalary: '20000.00' }] }),
    ).toThrow(/salary_missing: 2026-03-01/);
  });
});

describe('attendance adjustment — each rule, from the policy', () => {
  it('absence: daily wage, or nothing', () => {
    const days = month({ records: { '2026-03-02': absent, '2026-03-03': absent } });
    const charged = line({ days });
    expect(charged.counts.absentDays).toBe(2);
    expect(charged.exact.absence.toJSON()).toBe('4000/3');
    expect(charged.attendanceAdjustment.toString()).toBe('-1333.33');
    expect(charged.netSalary.toString()).toBe('18666.67');
    const free = line({ days, policy: { absenceDeduction: 'none' } });
    expect(free.attendanceAdjustment.toString()).toBe('0.00');
    expect(free.netSalary.toString()).toBe('20000.00');
  });

  it('unpaid leave: daily wage, scheduled-day wage, or nothing; paid leave costs nothing', () => {
    const days = month({ records: { '2026-03-02': leave(false), '2026-03-03': leave(true) } });
    const base = { salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '23000.00' }] };
    const daily = line({ ...base, days });
    expect(daily.counts.unpaidLeaveDays).toBe(1);
    expect(daily.counts.paidLeaveDays).toBe(1);
    expect(daily.attendanceAdjustment.toString()).toBe('-766.67');
    expect(
      line({
        ...base,
        days,
        policy: { unpaidLeaveDeduction: 'scheduled_day_wage' },
      }).attendanceAdjustment.toString(),
    ).toBe('-1000.00');
    expect(
      line({
        ...base,
        days,
        policy: { unpaidLeaveDeduction: 'none' },
      }).attendanceAdjustment.toString(),
    ).toBe('0.00');
  });

  it('lateness per minute: minutes × the day’s minute wage × the multiplier', () => {
    const days = month({ records: { '2026-03-02': present({ status: 'late', lateMinutes: 30 }) } });
    const result = line({
      days,
      salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '23000.00' }],
      policy: {
        dailyWageBasis: 'scheduled_working_days',
        fixedDaysValue: null,
        latenessRule: { type: 'per_minute', multiplier: '2.00' },
      },
    });
    // 1000 ÷ 420 × 30 × 2 = 1000/7
    expect(result.exact.lateness.toJSON()).toBe('1000/7');
    expect(result.attendanceAdjustment.toString()).toBe('-142.86');
    expect(result.counts.lateMinutes).toBe(30);
  });

  it('lateness fixed per incident: amount × late days', () => {
    const late = present({ status: 'late', lateMinutes: 5 });
    const days = month({ records: { '2026-03-02': late, '2026-03-04': late } });
    const result = line({
      days,
      policy: { latenessRule: { type: 'fixed_per_incident', amount: '50.00' } },
    });
    expect(result.counts.lateIncidents).toBe(2);
    expect(result.attendanceAdjustment.toString()).toBe('-100.00');
    expect(line({ days }).attendanceAdjustment.toString()).toBe('0.00');
  });

  it('overtime: paid schedules only, priced at the day’s hourly × rate', () => {
    const days = month({ records: { '2026-03-02': present({ overtimeMinutes: 60 }) } });
    const input = {
      days,
      salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '23000.00' }],
      policy: {
        dailyWageBasis: 'scheduled_working_days' as const,
        fixedDaysValue: null,
        overtimeRate: '1.50',
      },
    };
    const paid = line({ ...input, overtimePaid: true });
    // 1000 ÷ 7 hours × 1 hour × 1.5 = 1500/7
    expect(paid.exact.overtime.toJSON()).toBe('1500/7');
    expect(paid.attendanceAdjustment.toString()).toBe('214.29');
    expect(paid.netSalary.toString()).toBe('23214.29');
    expect(line({ ...input, overtimePaid: false }).attendanceAdjustment.toString()).toBe('0.00');
    expect(
      line({
        ...input,
        overtimePaid: true,
        policy: { ...input.policy, overtimeRate: '0.00' },
      }).attendanceAdjustment.toString(),
    ).toBe('0.00');
  });

  it('rest-day overtime has no hourly rate: reported unpriced and flagged', () => {
    const days = month({
      records: { '2026-03-06': present({ overtimeMinutes: 300 }) }, // a Friday
    });
    const result = line({ days, overtimePaid: true, policy: { overtimeRate: '1.50' } });
    expect(result.counts.unpricedOvertimeMinutes).toBe(300);
    expect(result.attendanceAdjustment.toString()).toBe('0.00');
    expect(result.reviewReasons).toContain('unpriced_overtime');
  });

  it('all of them together, exact', () => {
    const days = month({
      records: {
        '2026-03-02': absent,
        '2026-03-03': leave(false),
        '2026-03-04': present({ status: 'late', lateMinutes: 42 }),
        '2026-03-05': present({ overtimeMinutes: 84 }),
      },
    });
    const result = line({
      days,
      overtimePaid: true,
      salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '21000.00' }],
      policy: {
        fixedDaysValue: 30,
        latenessRule: { type: 'per_minute', multiplier: '1.00' },
        overtimeRate: '2.00',
      },
      deductions: ['250.00'],
      bonuses: ['500.50'],
    });
    // daily 700; minute 700/420 = 5/3
    expect(result.exact.absence.toJSON()).toBe('700/1');
    expect(result.exact.unpaidLeave.toJSON()).toBe('700/1');
    expect(result.exact.lateness.toJSON()).toBe('70/1'); // 42 × 5/3
    expect(result.exact.overtime.toJSON()).toBe('280/1'); // 84 × 5/3 × 2
    expect(result.attendanceAdjustment.toString()).toBe('-1190.00');
    expect(result.totalDeductions.toString()).toBe('250.00');
    expect(result.totalBonuses.toString()).toBe('500.50');
    expect(result.netSalary.toString()).toBe('20060.50');
  });
});

describe('attendance counts — worked, WFH, pending and missing days', () => {
  it('WFH and office are counted apart; half-day and pending count as worked', () => {
    const days = month({
      records: {
        '2026-03-02': present({ workMode: 'wfh' }),
        '2026-03-03': present({ status: 'half_day' }),
        '2026-03-04': present({ status: 'pending' }),
      },
    });
    const result = line({ days });
    expect(result.counts.wfhDays).toBe(1);
    expect(result.counts.presentDays).toBe(22);
    expect(result.counts.pendingDays).toEqual(['2026-03-04']);
    expect(result.reviewReasons).toEqual(['pending_days']);
    expect(result.netSalary.toString()).toBe('20000.00');
  });

  it('a working day with nothing recorded is absent (DOCUMENT 12 rule 10), and listed', () => {
    const result = line({ days: month({ records: { '2026-03-02': null } }) });
    expect(result.counts.absentDays).toBe(1);
    expect(result.counts.missingDays).toEqual(['2026-03-02']);
    expect(result.reviewReasons).toEqual(['missing_days']);
  });

  it('zero attendance: full absence adjustment, flagged for review, never paid in full', () => {
    const records = Object.fromEntries(
      month()
        .filter((d) => d.scheduledWorking)
        .map((d) => [`2026-03-${String(d.date.day).padStart(2, '0')}`, absent]),
    );
    const result = line({ days: month({ records }) });
    expect(result.counts.absentDays).toBe(23);
    expect(result.reviewReasons).toContain('zero_attendance');
    // 23 × 20000/30 = 15333.33 deducted
    expect(result.netSalary.toString()).toBe('4666.67');
  });
});

describe('net salary — exact, rounded once, never negative (OD-06)', () => {
  it('rounding happens once, on the exact net, not on the shown components', () => {
    // A third of a pound per day: 100 ÷ 3. Two absences.
    const days = month({ records: { '2026-03-02': absent, '2026-03-03': absent } });
    const result = line({
      days,
      salaries: [{ from: date('2025-01-01'), to: null, monthlySalary: '100.00' }],
      policy: { fixedDaysValue: 3 },
    });
    expect(result.exact.net.toJSON()).toBe('100/3');
    expect(result.netSalary.toString()).toBe('33.33');
    // Rounding each day first would have given 100 − 33.33 − 33.33 = 33.34.
    expect(result.netSalary.toString()).not.toBe('33.34');
  });

  it('none keeps piastres; nearest, up and down round to the pound', () => {
    const net = Fraction.parse('18666.50');
    expect(roundNet(net, 'none').toString()).toBe('18666.50');
    expect(roundNet(net, 'nearest').toString()).toBe('18667.00');
    expect(roundNet(net, 'up').toString()).toBe('18667.00');
    expect(roundNet(net, 'down').toString()).toBe('18666.00');
    expect(roundNet(Fraction.parse('18666.49'), 'nearest').toString()).toBe('18666.00');
  });

  it('flags a negative net instead of capping it', () => {
    const records = Object.fromEntries(
      [
        '02',
        '03',
        '04',
        '05',
        '08',
        '09',
        '10',
        '11',
        '12',
        '15',
        '16',
        '17',
        '18',
        '19',
        '22',
        '23',
        '24',
        '25',
        '26',
        '29',
        '30',
        '31',
        '01',
      ].map((d) => [`2026-03-${d}`, absent]),
    );
    // 23 absences at 20000/20 = 23000 > 20000.
    const result = line({ days: month({ records }), policy: { fixedDaysValue: 20 } });
    expect(result.negative).toBe(true);
    expect(result.exact.net.toJSON()).toBe('-3000/1');
  });

  it('renet: a deduction or bonus re-nets from the exact snapshot values', () => {
    const base = Fraction.parse('20000.00');
    const adjustment = Fraction.parse('-1000.00').divideByInteger(3);
    const result = renet({
      base,
      attendanceAdjustment: adjustment,
      deductions: ['100.00', '0.01'],
      bonuses: ['50.00'],
      rounding: 'none',
    });
    expect(result.totalDeductions.toString()).toBe('100.01');
    expect(result.totalBonuses.toString()).toBe('50.00');
    // 20000 − 333.333… − 100.01 + 50 = 19616.6566…
    expect(result.netSalary.toString()).toBe('19616.66');
    const blocked = renet({
      base,
      attendanceAdjustment: adjustment,
      deductions: ['19700.00'],
      bonuses: [],
      rounding: 'none',
    });
    expect(blocked.negative).toBe(true);
    expect(blocked.netSalary.toString()).toBe('-33.33');
  });
});

describe('the provisional estimate', () => {
  it('projects working days that have not happened as worked', () => {
    const days = month({ records: { '2026-03-02': absent, '2026-03-20': absent } });
    const result = line({ days, projectAfter: date('2026-03-10') });
    // 2 March charged; 20 March has not happened.
    expect(result.counts.absentDays).toBe(1);
    expect(result.counts.projectedDays).toBe(15);
    expect(result.netSalary.toString()).toBe('19333.33');
  });
});
