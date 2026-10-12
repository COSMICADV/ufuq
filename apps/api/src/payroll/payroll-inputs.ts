/**
 * What the engine needs for one month, read from the database — and the
 * snapshot that records it (DOCUMENT 06 §3.24, DOCUMENT 15 "snapshot holds all
 * computed inputs").
 *
 * The engine itself is pure (`payroll-engine.ts`). This file is the only one
 * that reads salary rows, schedules, holidays, attendance and the policy for
 * payroll, so the generation, the recalculation and the employee's estimate
 * all calculate from exactly the same inputs.
 *
 * Reads are batched per month: one query each for the employees, their salary
 * rows, their attendance, the holidays and the leave types. Schedules are
 * loaded once per distinct schedule.
 */

import type { Prisma, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { scheduledMinutes } from '../attendance/calculation.js';
import type { ScheduleSettings } from '../attendance/calculation.js';
import {
  dayFor,
  loadEmployeeSchedule,
  loadHolidays,
  ScheduleIncompleteError,
} from '../attendance/schedule-context.js';
import type { EmployeeSchedule } from '../attendance/schedule-context.js';
import { calendarDateIn, eachDay, formatCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';

import { Fraction } from './fraction.js';
import { calculatePayrollLine, ENGINE_VERSION, PayrollEngineError } from './payroll-engine.js';
import type {
  DayInput,
  DayStatus,
  EngineResult,
  LatenessRule,
  PolicyConfig,
  RoundingRule,
} from './payroll-engine.js';

export interface PolicyRow {
  readonly id: string;
  readonly name: string;
  readonly dailyWageBasis: PolicyConfig['dailyWageBasis'];
  readonly fixedDaysValue: number | null;
  readonly unpaidLeaveDeduction: PolicyConfig['unpaidLeaveDeduction'];
  readonly absenceDeduction: PolicyConfig['absenceDeduction'];
  readonly latenessRule: Prisma.JsonValue;
  readonly overtimeRate: Prisma.Decimal;
  readonly rounding: RoundingRule;
  readonly updatedAt: Date;
}

export function policyConfig(row: PolicyRow): PolicyConfig {
  return {
    dailyWageBasis: row.dailyWageBasis,
    fixedDaysValue: row.fixedDaysValue,
    unpaidLeaveDeduction: row.unpaidLeaveDeduction,
    absenceDeduction: row.absenceDeduction,
    latenessRule: row.latenessRule as unknown as LatenessRule,
    overtimeRate: moneyString(row.overtimeRate),
    rounding: row.rounding,
  };
}

/** The company's one policy (V1), or null when none has been saved. */
export async function loadPolicy(tx: TenantClient): Promise<PolicyRow | null> {
  return (await tx.salaryPolicy.findFirst({ where: { isDefault: true } })) as PolicyRow | null;
}

export interface MonthWindow {
  readonly year: number;
  readonly month: number;
  readonly start: CalendarDate;
  readonly end: CalendarDate;
}

export function monthWindow(year: number, month: number): MonthWindow {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, start: { year, month, day: 1 }, end: { year, month, day: last } };
}

export function dateValue(date: CalendarDate): Date {
  return new Date(`${formatCalendarDate(date)}T00:00:00.000Z`);
}

/**
 * A Prisma DECIMAL(…,2) as a 2-place string. Prisma's Decimal prints its exact
 * digits (`"20000"`, `"666.67"`); `@ufuq/money` pads them to the scale. No
 * JavaScript number is involved.
 */
export function moneyString(value: { toString(): string }): string {
  return Decimal.parse(value.toString(), 2).toString();
}

interface EmployeeRow {
  readonly id: string;
  readonly employeeCode: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly joiningDate: Date;
  readonly terminationDate: Date | null;
  readonly workScheduleId: string | null;
}

export type BlockingIssue =
  | 'salary_missing'
  | 'schedule_missing'
  | 'schedule_incomplete'
  | 'no_working_days_in_month'
  | 'negative_net';

export interface EmployeeCalculation {
  readonly employee: EmployeeRow;
  readonly result: EngineResult;
  readonly snapshot: Prisma.InputJsonObject;
}

export interface Blocked {
  readonly employee: EmployeeRow;
  readonly issue: BlockingIssue;
  readonly detail: string | null;
}

export interface MonthCalculation {
  readonly calculations: readonly EmployeeCalculation[];
  readonly blocked: readonly Blocked[];
}

/** Every non-deleted employee whose employment overlaps the month (approved decision). */
export async function eligibleEmployees(
  tx: TenantClient,
  window: MonthWindow,
  only?: readonly string[],
): Promise<EmployeeRow[]> {
  return tx.employee.findMany({
    where: {
      deletedAt: null,
      joiningDate: { lte: dateValue(window.end) },
      OR: [{ terminationDate: null }, { terminationDate: { gte: dateValue(window.start) } }],
      ...(only === undefined ? {} : { id: { in: [...only] } }),
    },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      joiningDate: true,
      terminationDate: true,
      workScheduleId: true,
    },
    orderBy: [{ employeeCode: 'asc' }, { id: 'asc' }],
  });
}

function scheduleSnapshot(id: string, schedule: EmployeeSchedule): Prisma.InputJsonObject {
  const settings: ScheduleSettings = schedule.settings;
  return {
    id,
    timezone: settings.timezone,
    grace_period_minutes: settings.gracePeriodMinutes,
    break_minutes: settings.breakMinutes,
    overtime_policy: settings.overtimePolicy,
    days: [...schedule.days.entries()]
      .sort(([a], [b]) => a - b)
      .map(([weekday, day]) => ({
        day_of_week: weekday,
        is_working_day: day.isWorkingDay,
        start_minutes: day.startMinutes,
        end_minutes: day.endMinutes,
      })),
  };
}

function policySnapshot(row: PolicyRow): Prisma.InputJsonObject {
  const config = policyConfig(row);
  return {
    id: row.id,
    name: row.name,
    daily_wage_basis: config.dailyWageBasis,
    fixed_days_value: config.fixedDaysValue,
    unpaid_leave_deduction: config.unpaidLeaveDeduction,
    absence_deduction: config.absenceDeduction,
    lateness_rule: config.latenessRule as unknown as Prisma.InputJsonObject,
    overtime_rate: config.overtimeRate,
    rounding: config.rounding,
    updated_at: row.updatedAt.toISOString(),
  };
}

function exactJson(result: EngineResult): Prisma.InputJsonObject {
  const e = result.exact;
  return {
    base: e.base.toJSON(),
    absence: e.absence.toJSON(),
    unpaid_leave: e.unpaidLeave.toJSON(),
    lateness: e.lateness.toJSON(),
    overtime: e.overtime.toJSON(),
    attendance_adjustment: e.attendanceAdjustment.toJSON(),
  };
}

/**
 * Calculate one month for the given employees. Employees who cannot be
 * calculated are returned as blocking issues, never guessed (DOCUMENT 15
 * rule 3). Deductions and bonuses, when given per employee, are applied, so
 * a recalculation keeps the Admin's entries.
 */
export async function calculateMonth(
  tx: TenantClient,
  policy: PolicyRow,
  window: MonthWindow,
  employees: readonly EmployeeRow[],
  entries: ReadonlyMap<string, { deductions: string[]; bonuses: string[] }> = new Map(),
  projectAfter?: CalendarDate,
): Promise<MonthCalculation> {
  const ids = employees.map((employee) => employee.id);
  const [salaries, records, holidays] = await Promise.all([
    tx.employeeSalary.findMany({
      where: {
        employeeId: { in: ids },
        effectiveFrom: { lte: dateValue(window.end) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dateValue(window.start) } }],
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
    tx.attendanceRecord.findMany({
      where: {
        employeeId: { in: ids },
        date: { gte: dateValue(window.start), lte: dateValue(window.end) },
      },
      select: {
        employeeId: true,
        date: true,
        status: true,
        checkInAt: true,
        workMode: true,
        lateMinutes: true,
        overtimeMinutes: true,
        leaveRequest: { select: { leaveType: { select: { isPaid: true } } } },
      },
    }),
    loadHolidays(tx, window.start, window.end),
  ]);

  const schedules = new Map<string, EmployeeSchedule>();
  const config = policyConfig(policy);
  const calculations: EmployeeCalculation[] = [];
  const blocked: Blocked[] = [];

  for (const employee of employees) {
    if (employee.workScheduleId === null) {
      blocked.push({ employee, issue: 'schedule_missing', detail: null });
      continue;
    }
    let schedule = schedules.get(employee.workScheduleId);
    if (schedule === undefined) {
      schedule = await loadEmployeeSchedule(tx, employee.workScheduleId);
      schedules.set(employee.workScheduleId, schedule);
    }

    const own = records.filter((record) => record.employeeId === employee.id);
    const byDate = new Map(own.map((record) => [record.date.toISOString().slice(0, 10), record]));
    let days: DayInput[];
    try {
      days = eachDay(window.start, window.end).map((date) => {
        const day = dayFor(schedule, date, employee.workScheduleId as string);
        const record = byDate.get(formatCalendarDate(date));
        return {
          date,
          scheduledWorking: day.isWorkingDay,
          isHoliday: holidays.has(formatCalendarDate(date)),
          scheduledMinutes: scheduledMinutes(day, schedule.settings),
          record:
            record === undefined
              ? null
              : {
                  status: record.status as DayStatus,
                  hasCheckIn: record.checkInAt !== null,
                  workMode: record.workMode as 'office' | 'wfh' | null,
                  lateMinutes: record.lateMinutes ?? 0,
                  overtimeMinutes: record.overtimeMinutes ?? 0,
                  leavePaid: record.leaveRequest?.leaveType.isPaid ?? null,
                },
        };
      });
    } catch (error) {
      if (error instanceof ScheduleIncompleteError) {
        blocked.push({ employee, issue: 'schedule_incomplete', detail: null });
        continue;
      }
      throw error;
    }

    const rows = salaries.filter((row) => row.employeeId === employee.id);
    const ownEntries = entries.get(employee.id) ?? { deductions: [], bonuses: [] };
    let result: EngineResult;
    try {
      result = calculatePayrollLine({
        year: window.year,
        month: window.month,
        policy: config,
        overtimePaid: schedule.settings.overtimePolicy === 'paid',
        joiningDate: calendarDateIn(employee.joiningDate, 'UTC'),
        terminationDate:
          employee.terminationDate === null
            ? null
            : calendarDateIn(employee.terminationDate, 'UTC'),
        salaries: rows.map((row) => ({
          from: calendarDateIn(row.effectiveFrom, 'UTC'),
          to: row.effectiveTo === null ? null : calendarDateIn(row.effectiveTo, 'UTC'),
          monthlySalary: moneyString(row.monthlySalary),
        })),
        days,
        deductions: ownEntries.deductions,
        bonuses: ownEntries.bonuses,
        ...(projectAfter === undefined ? {} : { projectAfter }),
      });
    } catch (error) {
      if (error instanceof PayrollEngineError) {
        if (error.code === 'not_employed_in_period') continue;
        blocked.push({
          employee,
          issue: error.code === 'policy_incomplete' ? 'salary_missing' : error.code,
          detail: error.detail,
        });
        continue;
      }
      throw error;
    }

    if (result.negative) {
      blocked.push({
        employee,
        issue: 'negative_net',
        detail: result.exact.net.toDecimal(2, 'nearest').toString(),
      });
      continue;
    }

    calculations.push({
      employee,
      result,
      snapshot: {
        engine_version: ENGINE_VERSION,
        period: { year: window.year, month: window.month },
        employee: {
          id: employee.id,
          code: employee.employeeCode,
          name: `${employee.firstName} ${employee.lastName}`,
          joining_date: formatCalendarDate(calendarDateIn(employee.joiningDate, 'UTC')),
          termination_date:
            employee.terminationDate === null
              ? null
              : formatCalendarDate(calendarDateIn(employee.terminationDate, 'UTC')),
        },
        policy: policySnapshot(policy),
        schedule: scheduleSnapshot(employee.workScheduleId, schedule),
        holidays: [...holidays].sort(),
        salaries: rows.map((row) => ({
          id: row.id,
          monthly_salary: moneyString(row.monthlySalary),
          currency: row.currency,
          effective_from: row.effectiveFrom.toISOString().slice(0, 10),
          effective_to:
            row.effectiveTo === null ? null : row.effectiveTo.toISOString().slice(0, 10),
        })),
        calendar_days_in_month: result.calendarDaysInMonth,
        working_days_in_month: result.workingDaysInMonth,
        employed_from: result.employedFrom,
        employed_to: result.employedTo,
        segments: result.segments.map((segment) => ({
          from: segment.from,
          to: segment.to,
          monthly_salary: segment.monthlySalary,
          working_days: segment.workingDays,
          base: segment.base.toJSON(),
          daily_wage: segment.dailyWage.toJSON(),
          scheduled_day_wage: segment.scheduledDayWage.toJSON(),
        })),
        days: days.map((day) => ({
          date: formatCalendarDate(day.date),
          working: day.scheduledWorking && !day.isHoliday,
          holiday: day.isHoliday,
          scheduled_minutes: day.scheduledMinutes,
          status: day.record?.status ?? null,
          work_mode: day.record?.workMode ?? null,
          late_minutes: day.record?.lateMinutes ?? 0,
          overtime_minutes: day.record?.overtimeMinutes ?? 0,
          leave_paid: day.record?.leavePaid ?? null,
        })),
        counts: {
          working_days: result.counts.workingDays,
          present_days: result.counts.presentDays,
          wfh_days: result.counts.wfhDays,
          absent_days: result.counts.absentDays,
          paid_leave_days: result.counts.paidLeaveDays,
          unpaid_leave_days: result.counts.unpaidLeaveDays,
          late_minutes: result.counts.lateMinutes,
          late_incidents: result.counts.lateIncidents,
          overtime_minutes: result.counts.overtimeMinutes,
          unpriced_overtime_minutes: result.counts.unpricedOvertimeMinutes,
          pending_days: [...result.counts.pendingDays],
          missing_days: [...result.counts.missingDays],
        },
        exact: exactJson(result),
        review_reasons: [...result.reviewReasons],
      },
    });
  }

  return { calculations, blocked };
}

/** The exact base and attendance adjustment a line's snapshot kept. */
export function snapshotExact(snapshot: Prisma.JsonValue): {
  readonly base: Fraction;
  readonly attendanceAdjustment: Fraction;
  readonly rounding: RoundingRule;
} {
  const s = snapshot as {
    exact: { base: string; attendance_adjustment: string };
    policy: { rounding: RoundingRule };
  };
  return {
    base: Fraction.fromJSON(s.exact.base),
    attendanceAdjustment: Fraction.fromJSON(s.exact.attendance_adjustment),
    rounding: s.policy.rounding,
  };
}

/** The company's calendar day (DOCUMENT 11 §9 — never the server's). */
export async function companyToday(tx: TenantClient, now: Date): Promise<CalendarDate> {
  const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
  return calendarDateIn(now, company.timezone);
}
