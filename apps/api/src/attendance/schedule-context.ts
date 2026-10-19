/**
 * Loading the configuration a day is judged against — DOCUMENT 06 §3.7–3.9,
 * DOCUMENT 27 RULE 12.
 *
 * Attendance is only ever evaluated against the schedule the employee is on
 * and the holidays their company has declared. Nothing here supplies a
 * default: a schedule with a missing weekday row is a configuration fault and
 * is reported as one, because inventing "probably a working day" is exactly
 * the hardcoded week RULE 12 forbids.
 *
 * DOCUMENT 12's "schedule changes mid-month" edge case is why the derived
 * values are written to the record when the day is evaluated, and not
 * recomputed later: this loader always reads the schedule as it is *now*, so
 * it is only ever correct to apply it to a day being evaluated now.
 */

import type { TenantClient } from '@ufuq/db';

import type { ScheduleDay, ScheduleSettings } from './calculation.js';
import type { CalendarDate } from './zoned-time.js';
import { dayOfWeek, formatCalendarDate, minutesFromTime } from './zoned-time.js';

export interface EmployeeSchedule {
  readonly settings: ScheduleSettings;
  /** Indexed 0–6, matching `work_schedule_days.day_of_week`. */
  readonly days: ReadonlyMap<number, ScheduleDay>;
}

export interface ScheduleContext extends EmployeeSchedule {
  /** `YYYY-MM-DD` of every holiday in the window asked for. */
  readonly holidays: ReadonlySet<string>;
}

/** Thrown when a schedule has no row for the weekday being evaluated. */
export class ScheduleIncompleteError extends Error {
  constructor(
    readonly workScheduleId: string,
    readonly missingDayOfWeek: number,
  ) {
    super(`work schedule ${workScheduleId} has no row for day_of_week ${String(missingDayOfWeek)}`);
    this.name = 'ScheduleIncompleteError';
  }
}

interface ScheduleRow {
  readonly id: string;
  readonly timezone: string;
  readonly gracePeriodMinutes: number;
  readonly breakMinutes: number;
  readonly halfDayThresholdHours: unknown;
  readonly overtimePolicy: string;
  readonly days: readonly {
    readonly dayOfWeek: number;
    readonly isWorkingDay: boolean;
    readonly startTime: Date | null;
    readonly endTime: Date | null;
  }[];
}

function toSchedule(row: ScheduleRow): EmployeeSchedule {
  const days = new Map<number, ScheduleDay>();
  for (const day of row.days) {
    days.set(day.dayOfWeek, {
      isWorkingDay: day.isWorkingDay,
      startMinutes: day.startTime === null ? null : minutesFromTime(day.startTime),
      endMinutes: day.endTime === null ? null : minutesFromTime(day.endTime),
    });
  }
  return {
    settings: {
      timezone: row.timezone,
      gracePeriodMinutes: row.gracePeriodMinutes,
      breakMinutes: row.breakMinutes,
      // Prisma returns DECIMAL as a Decimal object; `Number` is safe here
      // because this is an hours threshold (DOCUMENT 06 §3.7 DECIMAL(4,2)),
      // not money — no monetary value is ever read through this file.
      halfDayThresholdHours: Number(row.halfDayThresholdHours),
      overtimePolicy: row.overtimePolicy as ScheduleSettings['overtimePolicy'],
    },
    days,
  };
}

const SCHEDULE_SELECT = {
  id: true,
  timezone: true,
  gracePeriodMinutes: true,
  breakMinutes: true,
  halfDayThresholdHours: true,
  overtimePolicy: true,
  days: {
    select: { dayOfWeek: true, isWorkingDay: true, startTime: true, endTime: true },
  },
} as const;

/** The schedule an employee is on, with its seven weekday rows. */
export async function loadEmployeeSchedule(
  tx: TenantClient,
  workScheduleId: string,
): Promise<EmployeeSchedule> {
  const row = await tx.workSchedule.findUniqueOrThrow({
    where: { id: workScheduleId },
    select: SCHEDULE_SELECT,
  });
  return toSchedule(row as unknown as ScheduleRow);
}

/**
 * Several schedules in one query, keyed by id — for a calculation over many
 * employees (Phase 12 reports), so it does not read one schedule per person.
 */
export async function loadEmployeeSchedules(
  tx: TenantClient,
  workScheduleIds: readonly string[],
): Promise<ReadonlyMap<string, EmployeeSchedule>> {
  if (workScheduleIds.length === 0) {
    return new Map();
  }
  const rows = await tx.workSchedule.findMany({
    where: { id: { in: [...new Set(workScheduleIds)] } },
    select: SCHEDULE_SELECT,
  });
  return new Map(rows.map((row) => [row.id, toSchedule(row as unknown as ScheduleRow)]));
}

/** Every holiday between two dates, as `YYYY-MM-DD` strings. */
export async function loadHolidays(
  tx: TenantClient,
  from: CalendarDate,
  to: CalendarDate,
): Promise<ReadonlySet<string>> {
  const rows = await tx.holiday.findMany({
    where: {
      date: {
        gte: new Date(`${formatCalendarDate(from)}T00:00:00.000Z`),
        lte: new Date(`${formatCalendarDate(to)}T00:00:00.000Z`),
      },
    },
    select: { date: true },
  });
  return new Set(rows.map((row) => row.date.toISOString().slice(0, 10)));
}

export async function loadScheduleContext(
  tx: TenantClient,
  workScheduleId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<ScheduleContext> {
  const [schedule, holidays] = await Promise.all([
    loadEmployeeSchedule(tx, workScheduleId),
    loadHolidays(tx, from, to),
  ]);
  return { ...schedule, holidays };
}

/**
 * The schedule's row for a date. Throws rather than guessing — see the note at
 * the top of this file.
 */
export function dayFor(
  schedule: EmployeeSchedule,
  date: CalendarDate,
  workScheduleId: string,
): ScheduleDay {
  const weekday = dayOfWeek(date);
  const day = schedule.days.get(weekday);
  if (day === undefined) {
    throw new ScheduleIncompleteError(workScheduleId, weekday);
  }
  return day;
}

export function isHolidayOn(context: ScheduleContext, date: CalendarDate): boolean {
  return context.holidays.has(formatCalendarDate(date));
}
