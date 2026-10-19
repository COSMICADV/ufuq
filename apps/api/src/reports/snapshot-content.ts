/**
 * What a monthly employee report holds — DOCUMENT 18 "Employee reports",
 * DOCUMENT 05 FLOW 19, DOCUMENT 06 §3.27.
 *
 * Computed from the source modules with the **same** code the company reports
 * use, for one employee or many in a fixed number of queries:
 *
 *   - **attendance**: the attendance report's counts over the month's records
 *     (working days, present — of which office and WFH — late, absent, leave);
 *   - **tasks**: the task report's counts for the tasks due in the month
 *     (assigned, completed, in progress, overdue, on time);
 *   - **goals**: each goal's progress at the month's end, exactly as the
 *     performance calculation saw it (DOCUMENT 14 "the progress snapshot at
 *     each month end");
 *   - **salary**: the month's payroll line as the payroll module stored it
 *     (base, deductions, bonuses, net, adjustments); provisional unless the
 *     period is finalized, paid or adjusted; and stated as not generated when
 *     there is no payroll for the month — payroll is never computed here;
 *   - **performance**: `monthlyPerformance`, with the configuration and
 *     weights in effect stored inside it (DOCUMENT 14: historical reports stay
 *     explicable and are never rescored).
 *
 * **The fingerprint** is the SHA-256 of this content in canonical JSON. A
 * read recomputes the content from today's sources and compares: equal means
 * nothing the report shows has changed; different means the underlying data
 * (attendance, tasks, goals, payroll or the performance configuration) has —
 * DOCUMENT 18 rule 2's flag, proven rather than guessed from timestamps.
 * Everything in the content is a function of the sources alone for a closed
 * month (no "today" leaks in: every deadline in the month is already past).
 */

import { createHash } from 'node:crypto';

import { Prisma } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { formatCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { loadConfigRow, monthlyPerformance } from '../performance/performance-month.js';
import type {
  EmployeePerformancePayload,
  GoalAtMonthEnd,
  Month,
  PerformanceSubject,
} from '../performance/performance-month.js';

import { attendanceCounts, attendanceCountsSql } from './queries/attendance-report.js';
import type { AttendanceCountRow } from './queries/attendance-report.js';
import { isFinalPayroll } from './queries/payroll-report.js';
import { taskCounts, taskCountsSql, taskWindowSql } from './queries/tasks-report.js';
import type { TaskCountRow } from './queries/tasks-report.js';
import { dateParam, decimalOf, numeric } from './report-types.js';

export interface AttendanceSummary {
  readonly from: string;
  readonly to: string;
  readonly working_days: number;
  readonly present: number;
  readonly office: number;
  readonly wfh: number;
  readonly late: number;
  readonly half_day: number;
  readonly absent: number;
  readonly leave: number;
  readonly recorded_days: number;
}

export interface TaskSummary {
  readonly assigned: number;
  readonly completed: number;
  readonly in_progress: number;
  readonly not_started: number;
  readonly on_hold: number;
  readonly cancelled: number;
  readonly overdue: number;
  readonly completed_on_time: number;
  readonly completion_rate: string | null;
  readonly on_time_rate: string | null;
}

export interface GoalSummary {
  readonly goals: readonly GoalAtMonthEnd[];
}

export interface SalarySummary {
  /** `payroll`: from the month's payroll line; `none`: no payroll was generated for the month. */
  readonly source: 'payroll' | 'none';
  readonly period_id: string | null;
  readonly period_status: string | null;
  readonly is_provisional: boolean;
  readonly base: string | null;
  readonly attendance_adjustment: string | null;
  readonly deductions: string | null;
  readonly bonuses: string | null;
  readonly net: string | null;
  readonly adjustments_total: string | null;
  readonly adjusted_net: string | null;
}

export interface SnapshotContent {
  readonly attendance: AttendanceSummary;
  readonly tasks: TaskSummary;
  readonly goals: GoalSummary;
  readonly salary: SalarySummary;
  readonly performance: EmployeePerformancePayload;
  readonly overall: string | null;
  readonly provisional: boolean;
  readonly fingerprint: string;
}

/** JSON with every object's keys sorted, so equal content has one spelling. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
}

export function fingerprintOf(content: Omit<SnapshotContent, 'fingerprint'>): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        attendance: content.attendance,
        tasks: content.tasks,
        goals: content.goals,
        salary: content.salary,
        performance: content.performance,
      }),
    )
    .digest('hex');
}

function idList(ids: readonly string[]): Prisma.Sql {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

/** Every subject's content for `month`, keyed by employee id. */
export async function snapshotContents(
  tx: TenantClient,
  subjects: readonly PerformanceSubject[],
  month: Month,
  today: CalendarDate,
  timeZone: string,
): Promise<ReadonlyMap<string, SnapshotContent>> {
  const result = new Map<string, SnapshotContent>();
  if (subjects.length === 0) return result;
  const ids = subjects.map((subject) => subject.id);
  const range = {
    from: month.first,
    to: month.last,
    fromKey: formatCalendarDate(month.first),
    toKey: formatCalendarDate(month.last),
  };

  const attendanceRows = await tx.$queryRaw<(AttendanceCountRow & { employee_id: string })[]>`
    SELECT r."employee_id", ${attendanceCountsSql()}
      FROM "attendance_records" r
     WHERE r."employee_id" IN (${idList(ids)})
       AND r."date" BETWEEN ${dateParam(range.fromKey)} AND ${dateParam(range.toKey)}
     GROUP BY r."employee_id"`;
  const attendance = new Map(attendanceRows.map((row) => [row.employee_id, attendanceCounts(row)]));

  const todayKey = formatCalendarDate(today);
  const taskRows = await tx.$queryRaw<(TaskCountRow & { employee_id: string })[]>`
    SELECT t."assignee_employee_id" AS employee_id, ${taskCountsSql(todayKey, timeZone)}
      FROM "tasks" t
     WHERE t."assignee_employee_id" IN (${idList(ids)}) AND ${taskWindowSql(range, timeZone)}
     GROUP BY t."assignee_employee_id"`;
  const tasks = new Map(taskRows.map((row) => [row.employee_id, taskCounts(row)]));

  const lines = await tx.$queryRaw<
    {
      employee_id: string;
      period_id: string;
      period_status: string;
      base_salary: Prisma.Decimal;
      attendance_adjustment: Prisma.Decimal;
      total_deductions: Prisma.Decimal;
      total_bonuses: Prisma.Decimal;
      net_salary: Prisma.Decimal;
      adjustments: Prisma.Decimal | null;
    }[]
  >`
    SELECT l."employee_id", p."id" AS period_id, p."status"::text AS period_status,
           l."base_salary", l."attendance_adjustment", l."total_deductions", l."total_bonuses",
           l."net_salary",
           (SELECT SUM(a."amount") FROM "payroll_adjustments" a
             WHERE a."original_payroll_line_id" = l."id") AS adjustments
      FROM "payroll_lines" l
      JOIN "payroll_periods" p ON p."id" = l."payroll_period_id"
     WHERE p."year" = ${month.first.year} AND p."month" = ${month.first.month}
       AND l."employee_id" IN (${idList(ids)})`;
  const salaries = new Map(lines.map((line) => [line.employee_id, line]));

  const configRow = await loadConfigRow(tx);
  const performance = await monthlyPerformance(tx, subjects, month, today, timeZone, configRow);

  for (const subject of subjects) {
    const counts = attendance.get(subject.id);
    const attendanceSummary: AttendanceSummary = {
      from: range.fromKey,
      to: range.toKey,
      working_days: counts?.working_days ?? 0,
      present: counts?.present ?? 0,
      office: counts?.office ?? 0,
      wfh: counts?.wfh ?? 0,
      late: counts?.late ?? 0,
      half_day: counts?.half_day ?? 0,
      absent: counts?.absent ?? 0,
      leave: counts?.leave ?? 0,
      recorded_days: counts?.recorded_days ?? 0,
    };
    const taskRow = tasks.get(subject.id);
    const taskSummary: TaskSummary = {
      assigned: (taskRow?.['assigned'] as number | undefined) ?? 0,
      completed: (taskRow?.['completed'] as number | undefined) ?? 0,
      in_progress: (taskRow?.['in_progress'] as number | undefined) ?? 0,
      not_started: (taskRow?.['not_started'] as number | undefined) ?? 0,
      on_hold: (taskRow?.['on_hold'] as number | undefined) ?? 0,
      cancelled: (taskRow?.['cancelled'] as number | undefined) ?? 0,
      overdue: (taskRow?.['overdue'] as number | undefined) ?? 0,
      completed_on_time: (taskRow?.['completed_on_time'] as number | undefined) ?? 0,
      completion_rate: (taskRow?.['completion_rate'] as string | null | undefined) ?? null,
      on_time_rate: (taskRow?.['on_time_rate'] as string | null | undefined) ?? null,
    };
    const scores = performance.get(subject.id) as EmployeePerformancePayload;
    const line = salaries.get(subject.id);
    let salary: SalarySummary;
    if (line === undefined) {
      salary = {
        source: 'none',
        period_id: null,
        period_status: null,
        is_provisional: true,
        base: null,
        attendance_adjustment: null,
        deductions: null,
        bonuses: null,
        net: null,
        adjustments_total: null,
        adjusted_net: null,
      };
    } else {
      const net = decimalOf(line.net_salary, 2);
      const adjustments =
        line.adjustments === null ? Decimal.zero(2) : decimalOf(line.adjustments, 2);
      salary = {
        source: 'payroll',
        period_id: line.period_id,
        period_status: line.period_status,
        is_provisional: !isFinalPayroll(line.period_status),
        base: numeric(line.base_salary, 2),
        attendance_adjustment: numeric(line.attendance_adjustment, 2),
        deductions: numeric(line.total_deductions, 2),
        bonuses: numeric(line.total_bonuses, 2),
        net: net.toString(),
        adjustments_total: adjustments.toString(),
        adjusted_net: net.add(adjustments).toString(),
      };
    }
    const content = {
      attendance: attendanceSummary,
      tasks: taskSummary,
      goals: { goals: scores.components.goal.goals },
      salary,
      performance: scores,
      overall: scores.overall,
      provisional: salary.is_provisional || scores.is_provisional,
    };
    result.set(subject.id, { ...content, fingerprint: fingerprintOf(content) });
  }
  return result;
}
