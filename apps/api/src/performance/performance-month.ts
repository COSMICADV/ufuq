/**
 * One month's performance for one or many employees — DOCUMENT 14
 * "Performance", the interpretations recorded in docs/PHASE-8-STATUS.md.
 *
 * This is the single place the counts DOCUMENT 14 names are gathered from
 * attendance, tasks and goals and handed, with the company's configuration,
 * to the engine (`performance-rules.ts`). `GET /employees/{id}/performance`
 * calls it for one employee; the Phase 12 performance report and the monthly
 * report snapshot call it for many. There is no second scoring path.
 *
 * Reads are set-based: a fixed number of queries whatever the number of
 * employees (schedules, holidays, attendance records, tasks, goals and each
 * goal's latest progress before the month ended) — no query per employee or
 * per goal (DOCUMENT 26: no N+1).
 *
 * What "the month" means for each component:
 *
 *   - **Attendance** is measured over the scheduled working days of the month
 *     that have ended (up to yesterday, in the company's zone), within the
 *     employee's employment. Working days come from the employee's own
 *     schedule and the company's holidays — never a hardcoded week
 *     (DOCUMENT 27 RULE 12). Days are judged by the record the attendance
 *     engine wrote for them.
 *   - **Tasks** are the employee's uncancelled tasks due in the month (by
 *     deadline; a task with no deadline belongs to the month it was created
 *     in). On time means completed on or before the deadline's day.
 *   - **Goals** are the employee's uncancelled goals whose period overlaps
 *     the month, each at the value its history held at the month's end (or
 *     now, for the current month) — DOCUMENT 14 "Goal period spans two payroll
 *     months: … the progress snapshot at each month end".
 */

import { Prisma } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';

import { dateValue as calendarDateValue } from '../attendance/attendance-query.js';
import { dateToWire } from '../attendance/attendance-payload.js';
import {
  dayFor,
  loadEmployeeSchedules,
  loadHolidays,
  ScheduleIncompleteError,
} from '../attendance/schedule-context.js';
import type { ScheduleContext } from '../attendance/schedule-context.js';
import {
  calendarDateIn,
  compareDates,
  eachDay,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { fieldError } from '../company-structure/tenant-scoped.service.js';
import { valueToWire } from '../goals/goal-payload.js';
import { effectiveTarget, progressPercent } from '../goals/goal-rules.js';
import type { GoalTypeValue } from '../goals/goal-rules.js';

import {
  parsePerformanceConfig,
  PERFORMANCE_CONFIG_VERSION,
  performanceConfigToJson,
} from './performance-config.js';
import type { PerformanceConfig, PerformanceConfigJson } from './performance-config.js';
import { computePerformance } from './performance-rules.js';
import type { AttendanceInputs, TaskInputs } from './performance-rules.js';

/**
 * Why attendance has no score: the window held no scheduled working day; the
 * schedule cannot say which days are working days; or not one working day in
 * the window has a record — DOCUMENT 14 "Error states": a month with no data
 * is shown as "no data", never 0%.
 */
export type AttendanceNoDataReason = 'no_working_days' | 'schedule_incomplete' | 'no_records';

export interface EmployeePerformancePayload {
  readonly employee_id: string;
  readonly month: string;
  /** The month has not ended yet in the company's zone; the figures will move. */
  readonly is_provisional: boolean;
  /** The configuration these scores were computed with (DOCUMENT 14: explicable later). */
  readonly config: PerformanceConfigJson & { readonly schema_version: number };
  readonly components: {
    readonly attendance: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly no_data_reason: AttendanceNoDataReason | null;
      readonly inputs: {
        readonly from: string | null;
        readonly to: string | null;
        readonly working_days: number;
        readonly present_days: number;
        readonly wfh_days: number;
        readonly paid_leave_days: number;
        readonly late_incidents: number;
        readonly absent_days: number;
      } | null;
    };
    readonly task: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly completion_rate: string | null;
      readonly on_time_rate: string | null;
      readonly inputs: {
        readonly assigned: number;
        readonly completed: number;
        readonly completed_on_time: number;
      };
    };
    readonly goal: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly goals: readonly GoalAtMonthEnd[];
    };
  };
  /** Null is "no data" — never 0% (DOCUMENT 14 "Employees with no data"). */
  readonly overall: string | null;
}

export interface GoalAtMonthEnd {
  readonly id: string;
  readonly title: string;
  readonly type: GoalTypeValue;
  readonly progress_percent: string;
}

/** Who is being scored: the employment window and the schedule that defines working days. */
export interface PerformanceSubject {
  readonly id: string;
  readonly workScheduleId: string;
  readonly joiningDate: Date;
  readonly terminationDate: Date | null;
}

export const PERFORMANCE_SUBJECT_SELECT = {
  id: true,
  workScheduleId: true,
  joiningDate: true,
  terminationDate: true,
} as const;

export interface Month {
  readonly key: string;
  readonly first: CalendarDate;
  readonly last: CalendarDate;
}

/** Statuses of a day the employee attended (DOCUMENT 12 "Status values"). */
export const ATTENDED_STATUSES: readonly string[] = ['present', 'late', 'half_day', 'pending'];
const ATTENDED = new Set(ATTENDED_STATUSES);

/** `YYYY-MM`, defaulting to the company's current month; a future month is refused. */
export function resolveMonth(value: string | undefined, today: CalendarDate): Month {
  const key =
    value ?? `${String(today.year).padStart(4, '0')}-${String(today.month).padStart(2, '0')}`;
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const first = parseCalendarDate(`${key}-01`);
  if (match === null || first === null) {
    throw fieldError({ month: ['invalid'] });
  }
  if (compareDates(first, { year: today.year, month: today.month, day: 1 }) > 0) {
    throw fieldError({ month: ['invalid'] });
  }
  return monthOf(first.year, first.month);
}

/** The calendar month `year`-`month` (1–12). */
export function monthOf(year: number, monthNumber: number): Month {
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    key: `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`,
    first: { year, month: monthNumber, day: 1 },
    last: { year, month: monthNumber, day: lastDay },
  };
}

/** The stored configuration, refused if it is not the version this code understands. */
export function readConfig(row: {
  readonly schemaVersion: number;
  readonly config: Prisma.JsonValue;
}): PerformanceConfig {
  if (row.schemaVersion !== PERFORMANCE_CONFIG_VERSION) {
    throw new Error(`Unsupported performance_config schema version ${String(row.schemaVersion)}`);
  }
  const parsed = parsePerformanceConfig(row.config);
  if (!parsed.ok) {
    throw new Error('The stored performance configuration is not valid');
  }
  return parsed.config;
}

/** The company's configuration row; the database writes one for every company (Phase 8). */
export async function loadConfigRow(tx: TenantClient): Promise<{
  readonly schemaVersion: number;
  readonly config: Prisma.JsonValue;
}> {
  const row = await tx.performanceConfig.findFirst({
    select: { schemaVersion: true, config: true },
  });
  if (row === null) {
    // A company without one is a broken invariant, not a case to default.
    throw new Error('The company has no performance configuration');
  }
  return row;
}

/**
 * Every subject's scores for `month`, keyed by employee id. `today` is the
 * company's calendar day; the configuration row is the company's.
 */
export async function monthlyPerformance(
  tx: TenantClient,
  subjects: readonly PerformanceSubject[],
  month: Month,
  today: CalendarDate,
  timeZone: string,
  configRow: { readonly schemaVersion: number; readonly config: Prisma.JsonValue },
): Promise<ReadonlyMap<string, EmployeePerformancePayload>> {
  const result = new Map<string, EmployeePerformancePayload>();
  if (subjects.length === 0) {
    return result;
  }
  const config = readConfig(configRow);
  const json = performanceConfigToJson(config);
  const ids = subjects.map((subject) => subject.id);

  const attendance = await gatherAttendance(tx, subjects, month, today);
  const tasks = await gatherTasks(tx, ids, month, timeZone);
  const goals = await gatherGoals(tx, subjects, month, timeZone);

  for (const subject of subjects) {
    const a = attendance.get(subject.id) as AttendanceGathered;
    const task = tasks.get(subject.id) ?? { assigned: 0, completed: 0, completedOnTime: 0 };
    const goalRows = goals.get(subject.id) ?? [];
    const computed = computePerformance(
      {
        attendance: a.reason === null ? a.inputs : null,
        task,
        goalPercents: goalRows.map((goal) => goal.progress_percent),
      },
      config,
    );
    result.set(subject.id, {
      employee_id: subject.id,
      month: month.key,
      is_provisional: compareDates(month.last, today) >= 0,
      config: { schema_version: configRow.schemaVersion, ...json },
      components: {
        attendance: {
          score: computed.attendance.score,
          weight: json.weights.attendance,
          effective_weight: computed.effectiveWeights.attendance,
          no_data_reason: a.reason,
          inputs:
            a.inputs === null
              ? null
              : {
                  from: a.from,
                  to: a.to,
                  working_days: a.inputs.workingDays,
                  present_days: a.inputs.presentDays,
                  wfh_days: a.inputs.wfhDays,
                  paid_leave_days: a.inputs.paidLeaveDays,
                  late_incidents: a.inputs.lateIncidents,
                  absent_days: a.inputs.absentDays,
                },
        },
        task: {
          score: computed.task.score,
          weight: json.weights.task,
          effective_weight: computed.effectiveWeights.task,
          completion_rate: computed.task.completionRate,
          on_time_rate: computed.task.onTimeRate,
          inputs: {
            assigned: task.assigned,
            completed: task.completed,
            completed_on_time: task.completedOnTime,
          },
        },
        goal: {
          score: computed.goal.score,
          weight: json.weights.goal,
          effective_weight: computed.effectiveWeights.goal,
          goals: goalRows,
        },
      },
      overall: computed.overall,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Attendance — DOCUMENT 14: "against scheduled working days". The window is
// the month's ended days within employment; each scheduled working day is
// judged by its record.
// ---------------------------------------------------------------------------

interface AttendanceGathered {
  readonly inputs: AttendanceInputs | null;
  readonly reason: AttendanceNoDataReason | null;
  readonly from: string | null;
  readonly to: string | null;
}

const EMPTY_ATTENDANCE: AttendanceInputs = {
  workingDays: 0,
  presentDays: 0,
  wfhDays: 0,
  paidLeaveDays: 0,
  lateIncidents: 0,
  absentDays: 0,
};

async function gatherAttendance(
  tx: TenantClient,
  subjects: readonly PerformanceSubject[],
  month: Month,
  today: CalendarDate,
): Promise<ReadonlyMap<string, AttendanceGathered>> {
  const yesterday = previousDay(today);
  const windows = new Map<string, { from: CalendarDate; to: CalendarDate } | null>();
  for (const subject of subjects) {
    const joining = calendarDateIn(subject.joiningDate, 'UTC');
    const termination =
      subject.terminationDate === null ? null : calendarDateIn(subject.terminationDate, 'UTC');
    const from = latest(month.first, joining);
    const to = earliest(earliest(month.last, yesterday), termination);
    windows.set(subject.id, compareDates(from, to) > 0 ? null : { from, to });
  }
  const evaluated = subjects.filter((subject) => windows.get(subject.id) !== null);

  // One read each for the schedules, the month's holidays and the month's
  // records; every window lies inside the month, so each is a superset.
  const schedules = await loadEmployeeSchedules(
    tx,
    evaluated.map((subject) => subject.workScheduleId),
  );
  const holidays =
    evaluated.length === 0 ? new Set<string>() : await loadHolidays(tx, month.first, month.last);
  const records =
    evaluated.length === 0
      ? []
      : await tx.attendanceRecord.findMany({
          where: {
            employeeId: { in: evaluated.map((subject) => subject.id) },
            date: { gte: calendarDateValue(month.first), lte: calendarDateValue(month.last) },
          },
          select: { employeeId: true, date: true, status: true, workMode: true },
        });
  const byEmployee = new Map<string, Map<string, (typeof records)[number]>>();
  for (const record of records) {
    let own = byEmployee.get(record.employeeId);
    if (own === undefined) {
      own = new Map();
      byEmployee.set(record.employeeId, own);
    }
    own.set(dateToWire(record.date), record);
  }

  const result = new Map<string, AttendanceGathered>();
  for (const subject of subjects) {
    const window = windows.get(subject.id) ?? null;
    if (window === null) {
      result.set(subject.id, {
        inputs: EMPTY_ATTENDANCE,
        reason: 'no_working_days',
        from: null,
        to: null,
      });
      continue;
    }
    const schedule = schedules.get(subject.workScheduleId);
    if (schedule === undefined) {
      throw new Error(`work schedule ${subject.workScheduleId} was not found`);
    }
    const context: ScheduleContext = { ...schedule, holidays };
    let working: CalendarDate[];
    try {
      working = eachDay(window.from, window.to).filter(
        (date) =>
          dayFor(context, date, subject.workScheduleId).isWorkingDay &&
          !holidays.has(formatCalendarDate(date)),
      );
    } catch (error) {
      if (error instanceof ScheduleIncompleteError) {
        // DOCUMENT 27 RULE 12: a schedule with a missing weekday cannot say
        // which days were working days, and inventing them is the defect the
        // rule forbids. The component is reported as having no data.
        result.set(subject.id, {
          inputs: null,
          reason: 'schedule_incomplete',
          from: formatCalendarDate(window.from),
          to: formatCalendarDate(window.to),
        });
        continue;
      }
      throw error;
    }

    const byDate = byEmployee.get(subject.id) ?? new Map<string, (typeof records)[number]>();
    let recorded = 0;
    let presentDays = 0;
    let wfhDays = 0;
    let paidLeaveDays = 0;
    let lateIncidents = 0;
    let absentDays = 0;
    for (const date of working) {
      const record = byDate.get(formatCalendarDate(date));
      if (record === undefined) continue;
      recorded += 1;
      if (ATTENDED.has(record.status)) {
        if (record.workMode === 'wfh') wfhDays += 1;
        else presentDays += 1;
      }
      if (record.status === 'late') lateIncidents += 1;
      if (record.status === 'absent') absentDays += 1;
      if (record.status === 'on_leave') paidLeaveDays += 1;
    }
    result.set(subject.id, {
      inputs: {
        workingDays: working.length,
        presentDays,
        wfhDays,
        paidLeaveDays,
        lateIncidents,
        absentDays,
      },
      reason: working.length === 0 ? 'no_working_days' : recorded === 0 ? 'no_records' : null,
      from: formatCalendarDate(window.from),
      to: formatCalendarDate(window.to),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tasks — DOCUMENT 14 "Task score" counts for the month.
// ---------------------------------------------------------------------------

async function gatherTasks(
  tx: TenantClient,
  employeeIds: readonly string[],
  month: Month,
  timeZone: string,
): Promise<ReadonlyMap<string, TaskInputs>> {
  const tasks = await tx.task.findMany({
    where: {
      assigneeEmployeeId: { in: [...employeeIds] },
      deletedAt: null,
      status: { not: 'cancelled' },
      OR: [
        {
          deadline: {
            gte: calendarDateValue(month.first),
            lte: calendarDateValue(month.last),
          },
        },
        {
          deadline: null,
          createdAt: {
            gte: instantAt(month.first, 0, timeZone),
            lt: instantAt(month.last, 24 * 60, timeZone),
          },
        },
      ],
    },
    select: { assigneeEmployeeId: true, status: true, deadline: true, completedAt: true },
  });
  const counts = new Map<
    string,
    { assigned: number; completed: number; completedOnTime: number }
  >();
  for (const task of tasks) {
    let own = counts.get(task.assigneeEmployeeId);
    if (own === undefined) {
      own = { assigned: 0, completed: 0, completedOnTime: 0 };
      counts.set(task.assigneeEmployeeId, own);
    }
    own.assigned += 1;
    if (task.status !== 'completed' || task.completedAt === null) continue;
    own.completed += 1;
    const day = formatCalendarDate(calendarDateIn(task.completedAt, timeZone));
    if (task.deadline === null || day <= dateToWire(task.deadline)) {
      own.completedOnTime += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Goals — DOCUMENT 14 "Goal score": the employee's goals in the period, each
// at the value its history held at the end of the month (or now).
// ---------------------------------------------------------------------------

async function gatherGoals(
  tx: TenantClient,
  subjects: readonly PerformanceSubject[],
  month: Month,
  timeZone: string,
): Promise<ReadonlyMap<string, readonly GoalAtMonthEnd[]>> {
  // Everything written before the month ended — for the current month,
  // everything written so far.
  const asOf = instantAt(month.last, 24 * 60, timeZone);
  const goals = await tx.goal.findMany({
    where: {
      employeeId: { in: subjects.map((subject) => subject.id) },
      deletedAt: null,
      status: { not: 'cancelled' },
      periodStart: { lte: calendarDateValue(month.last) },
      periodEnd: { gte: calendarDateValue(month.first) },
      createdAt: { lt: asOf },
    },
    select: {
      id: true,
      employeeId: true,
      title: true,
      type: true,
      periodStart: true,
      periodEnd: true,
    },
    orderBy: [{ periodEnd: 'asc' }, { id: 'asc' }],
  });
  const snapshots = new Map<string, { value: Prisma.Decimal; target_value: Prisma.Decimal }>();
  if (goals.length > 0) {
    // The latest history row per goal before the month ended, in one query.
    const rows = await tx.$queryRaw<
      { goal_id: string; value: Prisma.Decimal; target_value: Prisma.Decimal }[]
    >`
      SELECT DISTINCT ON (gp."goal_id") gp."goal_id", gp."value", gp."target_value"
        FROM "goal_progress" gp
       WHERE gp."goal_id" IN (${Prisma.join(goals.map((goal) => Prisma.sql`${goal.id}::uuid`))})
         AND gp."created_at" < ${asOf}
       ORDER BY gp."goal_id", gp."created_at" DESC, gp."id" DESC`;
    for (const row of rows) {
      snapshots.set(row.goal_id, { value: row.value, target_value: row.target_value });
    }
  }
  const terminationById = new Map(
    subjects.map((subject) => [
      subject.id,
      subject.terminationDate === null ? null : dateToWire(subject.terminationDate),
    ]),
  );
  const result = new Map<string, GoalAtMonthEnd[]>();
  for (const goal of goals) {
    const snapshot = snapshots.get(goal.id);
    if (snapshot === undefined) continue;
    const target = effectiveTarget(
      valueToWire(snapshot.target_value),
      dateToWire(goal.periodStart),
      dateToWire(goal.periodEnd),
      terminationById.get(goal.employeeId) ?? null,
    );
    let own = result.get(goal.employeeId);
    if (own === undefined) {
      own = [];
      result.set(goal.employeeId, own);
    }
    own.push({
      id: goal.id,
      title: goal.title,
      type: goal.type as GoalTypeValue,
      progress_percent: progressPercent(valueToWire(snapshot.value), target),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Calendar helpers
// ---------------------------------------------------------------------------

function previousDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) - 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function latest(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) >= 0 ? a : b;
}

function earliest(a: CalendarDate, b: CalendarDate | null): CalendarDate {
  return b === null || compareDates(a, b) <= 0 ? a : b;
}
