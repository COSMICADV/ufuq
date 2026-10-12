/**
 * The payroll calculation engine — DOCUMENT 15 "SALARY CALCULATION ENGINE",
 * with the Phase 11 decisions recorded in docs/PHASE-11-STATUS.md.
 *
 * Pure: it reads no database and no clock. Every input arrives as data — the
 * salary policy, the salary rows, each calendar day of the month with its
 * schedule, holiday and attendance — so every rule is unit-testable, and the
 * snapshot a finalized line stores is exactly what went in.
 *
 * **Configuration, not code** (DOCUMENT 15 "Critical rule"). Each step reads
 * the policy:
 *
 *   daily wage    fixed_days              monthly ÷ fixed_days_value
 *                 scheduled_working_days  monthly ÷ scheduled working days in the month
 *                 calendar_days           monthly ÷ calendar days in the month
 *   base salary   monthly × (scheduled working days in the segment ÷ in the
 *                 month), per salary segment — the approved working-day share,
 *                 whatever the basis. A full month is the full salary.
 *   absence       absent working day × daily wage, or nothing
 *   unpaid leave  unpaid leave day × daily wage, or × scheduled-day wage
 *                 (monthly ÷ scheduled working days), or nothing
 *   lateness      none; per_minute: late minutes × the day's minute wage
 *                 (daily wage ÷ scheduled minutes) × multiplier;
 *                 fixed_per_incident: amount × late days
 *   overtime      only for a schedule whose overtime policy is `paid`:
 *                 overtime minutes × the day's minute wage × overtime_rate.
 *                 Overtime on a day with no scheduled minutes (a rest day or a
 *                 holiday worked) has no rate to price it with: it is reported,
 *                 unpriced, and the line is flagged for review.
 *   net           base + attendance adjustment − deductions + bonuses
 *   rounding      once, on the net only: `none` keeps piastres (0.01, half
 *                 away from zero, which DECIMAL(15,2) requires anyway);
 *                 `nearest` / `up` / `down` round to a whole pound.
 *
 * Every intermediate amount is an exact `Fraction`. The stored components
 * (base, daily wage, attendance adjustment) are shown at 0.01; the net is
 * rounded from the exact sum, never from the shown components.
 *
 * **Attendance** (DOCUMENT 15 step 3, approved decisions): present, late,
 * half-day and pending days with a real check-in count as worked — office or
 * WFH by their work mode — with no automatic deduction; lateness still applies
 * on them. A working day with no record (or a record with no check-in that is
 * not leave or absence) is what DOCUMENT 12 rule 10 makes it: absent. The
 * generation warning lists those days and pending days, so the Admin proceeds
 * knowingly.
 */

import { Decimal } from '@ufuq/money';

import type { CalendarDate } from '../attendance/zoned-time.js';
import { compareDates, formatCalendarDate } from '../attendance/zoned-time.js';

import { Fraction } from './fraction.js';

export const ENGINE_VERSION = 1;

export type DailyWageBasis = 'fixed_days' | 'scheduled_working_days' | 'calendar_days';
export type UnpaidLeaveRule = 'daily_wage' | 'scheduled_day_wage' | 'none';
export type AbsenceRule = 'daily_wage' | 'none';
export type RoundingRule = 'none' | 'nearest' | 'up' | 'down';

export type LatenessRule =
  | { readonly type: 'none' }
  | { readonly type: 'per_minute'; readonly multiplier: string }
  | { readonly type: 'fixed_per_incident'; readonly amount: string };

export interface PolicyConfig {
  readonly dailyWageBasis: DailyWageBasis;
  readonly fixedDaysValue: number | null;
  readonly unpaidLeaveDeduction: UnpaidLeaveRule;
  readonly absenceDeduction: AbsenceRule;
  readonly latenessRule: LatenessRule;
  /** DECIMAL(5,2) as a string; `"0.00"` pays no overtime. */
  readonly overtimeRate: string;
  readonly rounding: RoundingRule;
}

export interface SalaryRow {
  readonly from: CalendarDate;
  /** Inclusive; null while the row is open. */
  readonly to: CalendarDate | null;
  /** DECIMAL(15,2) as a string. */
  readonly monthlySalary: string;
}

export type DayStatus =
  | 'present'
  | 'absent'
  | 'late'
  | 'on_leave'
  | 'half_day'
  | 'holiday'
  | 'weekend'
  | 'pending';

export interface DayRecord {
  readonly status: DayStatus;
  readonly hasCheckIn: boolean;
  readonly workMode: 'office' | 'wfh' | null;
  readonly lateMinutes: number;
  readonly overtimeMinutes: number;
  /** For an `on_leave` day: whether the leave type is paid. */
  readonly leavePaid: boolean | null;
}

export interface DayInput {
  readonly date: CalendarDate;
  /** The schedule's weekday says it is worked. */
  readonly scheduledWorking: boolean;
  readonly isHoliday: boolean;
  /** The schedule's minutes that day, net of the break; 0 on a rest day. */
  readonly scheduledMinutes: number;
  readonly record: DayRecord | null;
}

export interface EngineInput {
  readonly year: number;
  readonly month: number;
  readonly policy: PolicyConfig;
  /** The schedule's overtime policy is `paid` (DOCUMENT 12 rule 6). */
  readonly overtimePaid: boolean;
  readonly joiningDate: CalendarDate;
  readonly terminationDate: CalendarDate | null;
  readonly salaries: readonly SalaryRow[];
  /** Every calendar day of the month, in order. */
  readonly days: readonly DayInput[];
  /** DECIMAL(15,2) strings. */
  readonly deductions: readonly string[];
  readonly bonuses: readonly string[];
  /**
   * For the employee's provisional estimate only: working days after this
   * date have not happened, and are projected as worked.
   */
  readonly projectAfter?: CalendarDate;
}

export type EngineErrorCode =
  | 'not_employed_in_period'
  | 'salary_missing'
  | 'no_working_days_in_month'
  | 'policy_incomplete';

export class PayrollEngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    readonly detail: string | null = null,
  ) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = 'PayrollEngineError';
  }
}

export interface SegmentResult {
  readonly from: string;
  readonly to: string;
  readonly monthlySalary: string;
  readonly workingDays: number;
  readonly base: Fraction;
  readonly dailyWage: Fraction;
  readonly scheduledDayWage: Fraction;
}

export interface Counts {
  readonly workingDays: number;
  readonly presentDays: number;
  readonly wfhDays: number;
  readonly absentDays: number;
  readonly paidLeaveDays: number;
  readonly unpaidLeaveDays: number;
  readonly lateMinutes: number;
  readonly lateIncidents: number;
  readonly overtimeMinutes: number;
  readonly unpricedOvertimeMinutes: number;
  readonly pendingDays: readonly string[];
  readonly missingDays: readonly string[];
  readonly projectedDays: number;
}

export interface ExactAmounts {
  readonly base: Fraction;
  readonly absence: Fraction;
  readonly unpaidLeave: Fraction;
  readonly lateness: Fraction;
  readonly overtime: Fraction;
  readonly attendanceAdjustment: Fraction;
  readonly deductions: Fraction;
  readonly bonuses: Fraction;
  readonly net: Fraction;
}

export type ReviewReason =
  | 'zero_attendance'
  | 'pending_days'
  | 'missing_days'
  | 'unpriced_overtime';

export interface EngineResult {
  readonly calendarDaysInMonth: number;
  readonly workingDaysInMonth: number;
  readonly employedFrom: string;
  readonly employedTo: string;
  readonly segments: readonly SegmentResult[];
  readonly counts: Counts;
  readonly exact: ExactAmounts;
  /** Shown components, at 0.01 half away from zero. */
  readonly baseSalary: Decimal;
  readonly dailyWage: Decimal;
  readonly attendanceAdjustment: Decimal;
  readonly totalDeductions: Decimal;
  readonly totalBonuses: Decimal;
  /** The net, rounded once per the policy. */
  readonly netSalary: Decimal;
  /** OD-06: the exact or the rounded net is below zero. The caller refuses it. */
  readonly negative: boolean;
  readonly reviewReasons: readonly ReviewReason[];
}

const MONEY = 2;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function maxDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) >= 0 ? a : b;
}

function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) <= 0 ? a : b;
}

function within(date: CalendarDate, from: CalendarDate, to: CalendarDate | null): boolean {
  return compareDates(date, from) >= 0 && (to === null || compareDates(date, to) <= 0);
}

/** The net, rounded once per policy (approved decision). */
export function roundNet(net: Fraction, rounding: RoundingRule): Decimal {
  if (rounding === 'none') {
    return net.toDecimal(MONEY, 'nearest');
  }
  return net.toDecimal(0, rounding).rescale(MONEY);
}

/** A shown component: 0.01, half away from zero. */
export function shown(value: Fraction): Decimal {
  return value.toDecimal(MONEY, 'nearest');
}

function money(value: string): Fraction {
  return Fraction.fromDecimal(Decimal.parse(value, MONEY));
}

function dailyWageFor(
  policy: PolicyConfig,
  monthly: Fraction,
  workingDaysInMonth: number,
  calendarDays: number,
): Fraction {
  switch (policy.dailyWageBasis) {
    case 'fixed_days':
      if (policy.fixedDaysValue === null || policy.fixedDaysValue <= 0) {
        throw new PayrollEngineError('policy_incomplete', 'fixed_days_value');
      }
      return monthly.divideByInteger(policy.fixedDaysValue);
    case 'scheduled_working_days':
      return monthly.divideByInteger(workingDaysInMonth);
    case 'calendar_days':
      return monthly.divideByInteger(calendarDays);
  }
}

/** True on a day the schedule works and no holiday falls. */
function isWorkingDay(day: DayInput): boolean {
  return day.scheduledWorking && !day.isHoliday;
}

function worked(record: DayRecord): boolean {
  return (
    record.hasCheckIn &&
    (record.status === 'present' ||
      record.status === 'late' ||
      record.status === 'half_day' ||
      record.status === 'pending')
  );
}

export function calculatePayrollLine(input: EngineInput): EngineResult {
  const { policy } = input;
  const calendarDays = daysInMonth(input.year, input.month);
  const monthStart: CalendarDate = { year: input.year, month: input.month, day: 1 };
  const monthEnd: CalendarDate = { year: input.year, month: input.month, day: calendarDays };
  if (input.days.length !== calendarDays) {
    throw new RangeError(
      `Expected ${String(calendarDays)} days, got ${String(input.days.length)}.`,
    );
  }

  const employedFrom = maxDate(monthStart, input.joiningDate);
  const employedTo =
    input.terminationDate === null ? monthEnd : minDate(monthEnd, input.terminationDate);
  if (compareDates(employedFrom, employedTo) > 0) {
    throw new PayrollEngineError('not_employed_in_period');
  }

  const workingDaysInMonth = input.days.filter(isWorkingDay).length;
  if (workingDaysInMonth === 0) {
    throw new PayrollEngineError('no_working_days_in_month');
  }

  // Salary segments, clipped to the employment window. Every employed day
  // must be covered by exactly one row (the database forbids overlap).
  const rows = [...input.salaries].sort((a, b) => compareDates(a.from, b.from));
  const segmentOf = (date: CalendarDate): number => {
    const index = rows.findIndex((row) => within(date, row.from, row.to));
    if (index < 0) {
      throw new PayrollEngineError('salary_missing', formatCalendarDate(date));
    }
    return index;
  };

  const employedDays = input.days.filter((day) => within(day.date, employedFrom, employedTo));
  const segmentWorkingDays = new Map<number, number>();
  for (const day of employedDays) {
    const index = segmentOf(day.date);
    if (isWorkingDay(day)) {
      segmentWorkingDays.set(index, (segmentWorkingDays.get(index) ?? 0) + 1);
    } else if (!segmentWorkingDays.has(index)) {
      segmentWorkingDays.set(index, 0);
    }
  }

  const segments: SegmentResult[] = [];
  const wages = new Map<number, { daily: Fraction; scheduledDay: Fraction }>();
  for (const [index, working] of [...segmentWorkingDays].sort(([a], [b]) => a - b)) {
    const row = rows[index] as SalaryRow;
    const monthly = money(row.monthlySalary);
    const daily = dailyWageFor(policy, monthly, workingDaysInMonth, calendarDays);
    const scheduledDay = monthly.divideByInteger(workingDaysInMonth);
    wages.set(index, { daily, scheduledDay });
    segments.push({
      from: formatCalendarDate(maxDate(row.from, employedFrom)),
      to: formatCalendarDate(row.to === null ? employedTo : minDate(row.to, employedTo)),
      monthlySalary: Decimal.parse(row.monthlySalary, MONEY).toString(),
      workingDays: working,
      base: monthly.multiplyByInteger(working).divideByInteger(workingDaysInMonth),
      dailyWage: daily,
      scheduledDayWage: scheduledDay,
    });
  }

  const overtimeRate = money(policy.overtimeRate);
  let absence = Fraction.zero();
  let unpaidLeave = Fraction.zero();
  let lateness = Fraction.zero();
  let overtime = Fraction.zero();
  const counts = {
    workingDays: 0,
    presentDays: 0,
    wfhDays: 0,
    absentDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    lateMinutes: 0,
    lateIncidents: 0,
    overtimeMinutes: 0,
    unpricedOvertimeMinutes: 0,
    pendingDays: [] as string[],
    missingDays: [] as string[],
    projectedDays: 0,
  };

  for (const day of employedDays) {
    const wage = wages.get(segmentOf(day.date)) as { daily: Fraction; scheduledDay: Fraction };
    const minuteWage =
      day.scheduledMinutes > 0 ? wage.daily.divideByInteger(day.scheduledMinutes) : null;
    const record = day.record;
    const working = isWorkingDay(day);
    if (working) counts.workingDays += 1;

    if (
      working &&
      input.projectAfter !== undefined &&
      compareDates(day.date, input.projectAfter) > 0
    ) {
      // Provisional estimate: a day that has not happened yet.
      counts.projectedDays += 1;
      continue;
    }

    if (record !== null && worked(record)) {
      if (working) {
        if (record.workMode === 'wfh') counts.wfhDays += 1;
        else counts.presentDays += 1;
      }
      if (record.status === 'pending') counts.pendingDays.push(formatCalendarDate(day.date));
      if (record.lateMinutes > 0) {
        counts.lateMinutes += record.lateMinutes;
        counts.lateIncidents += 1;
        if (policy.latenessRule.type === 'per_minute' && minuteWage !== null) {
          lateness = lateness.add(
            minuteWage
              .multiplyByInteger(record.lateMinutes)
              .multiply(money(policy.latenessRule.multiplier)),
          );
        } else if (policy.latenessRule.type === 'fixed_per_incident') {
          lateness = lateness.add(money(policy.latenessRule.amount));
        }
      }
      if (record.overtimeMinutes > 0 && input.overtimePaid && !overtimeRate.isZero()) {
        counts.overtimeMinutes += record.overtimeMinutes;
        if (minuteWage === null) {
          counts.unpricedOvertimeMinutes += record.overtimeMinutes;
        } else {
          overtime = overtime.add(
            minuteWage.multiplyByInteger(record.overtimeMinutes).multiply(overtimeRate),
          );
        }
      }
      continue;
    }

    if (!working) continue;

    if (record !== null && record.status === 'on_leave') {
      if (record.leavePaid === true) {
        counts.paidLeaveDays += 1;
      } else {
        counts.unpaidLeaveDays += 1;
        if (policy.unpaidLeaveDeduction === 'daily_wage') {
          unpaidLeave = unpaidLeave.add(wage.daily);
        } else if (policy.unpaidLeaveDeduction === 'scheduled_day_wage') {
          unpaidLeave = unpaidLeave.add(wage.scheduledDay);
        }
      }
      continue;
    }

    if (record !== null && (record.status === 'holiday' || record.status === 'weekend')) {
      // The calendar changed after the day was recorded: not an absence.
      continue;
    }

    // Absent: recorded so, or (DOCUMENT 12 rule 10) a working day with
    // nothing recorded — listed so the Admin proceeds knowingly.
    if (record === null || record.status !== 'absent') {
      counts.missingDays.push(formatCalendarDate(day.date));
    }
    counts.absentDays += 1;
    if (policy.absenceDeduction === 'daily_wage') {
      absence = absence.add(wage.daily);
    }
  }

  const base = Fraction.sum(segments.map((segment) => segment.base));
  const attendanceAdjustment = overtime.subtract(absence).subtract(unpaidLeave).subtract(lateness);
  const deductions = Fraction.sum(input.deductions.map(money));
  const bonuses = Fraction.sum(input.bonuses.map(money));
  const net = base.add(attendanceAdjustment).subtract(deductions).add(bonuses);
  const netSalary = roundNet(net, policy.rounding);

  const reviewReasons: ReviewReason[] = [];
  if (
    counts.workingDays - counts.projectedDays > 0 &&
    counts.presentDays + counts.wfhDays + counts.paidLeaveDays === 0
  ) {
    reviewReasons.push('zero_attendance');
  }
  if (counts.pendingDays.length > 0) reviewReasons.push('pending_days');
  if (counts.missingDays.length > 0) reviewReasons.push('missing_days');
  if (counts.unpricedOvertimeMinutes > 0) reviewReasons.push('unpriced_overtime');

  const lastSegment = segments[segments.length - 1] as SegmentResult;
  return {
    calendarDaysInMonth: calendarDays,
    workingDaysInMonth,
    employedFrom: formatCalendarDate(employedFrom),
    employedTo: formatCalendarDate(employedTo),
    segments,
    counts,
    exact: {
      base,
      absence,
      unpaidLeave,
      lateness,
      overtime,
      attendanceAdjustment,
      deductions,
      bonuses,
      net,
    },
    baseSalary: shown(base),
    dailyWage: shown(lastSegment.dailyWage),
    attendanceAdjustment: shown(attendanceAdjustment),
    totalDeductions: deductions.toDecimal(MONEY, 'exact'),
    totalBonuses: bonuses.toDecimal(MONEY, 'exact'),
    netSalary,
    negative: net.isNegative() || netSalary.isNegative(),
    reviewReasons,
  };
}

/**
 * Re-net a line whose deductions or bonuses changed, from the exact base and
 * attendance adjustment its snapshot kept — so a deduction never re-reads
 * attendance or the policy, and the net is still rounded once, from exact
 * values.
 */
export function renet(input: {
  readonly base: Fraction;
  readonly attendanceAdjustment: Fraction;
  readonly deductions: readonly string[];
  readonly bonuses: readonly string[];
  readonly rounding: RoundingRule;
}): {
  readonly net: Fraction;
  readonly netSalary: Decimal;
  readonly totalDeductions: Decimal;
  readonly totalBonuses: Decimal;
  readonly negative: boolean;
} {
  const deductions = Fraction.sum(input.deductions.map(money));
  const bonuses = Fraction.sum(input.bonuses.map(money));
  const net = input.base.add(input.attendanceAdjustment).subtract(deductions).add(bonuses);
  const netSalary = roundNet(net, input.rounding);
  return {
    net,
    netSalary,
    totalDeductions: deductions.toDecimal(MONEY, 'exact'),
    totalBonuses: bonuses.toDecimal(MONEY, 'exact'),
    negative: net.isNegative() || netSalary.isNegative(),
  };
}
