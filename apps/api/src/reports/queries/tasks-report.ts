/**
 * Task report — DOCUMENT 18 "Company reports": assigned, completed, in
 * progress, overdue and on-time rate by employee and department.
 *
 * The canonical task semantics, not new ones:
 *
 *   - **Which tasks**: those *due* in the range — by deadline, and a task with
 *     no deadline by the day it was created (in the company's zone). The same
 *     window the performance engine scores a month by (DOCUMENT 14).
 *     Soft-deleted tasks are never counted.
 *   - **Assigned**: every such task except a cancelled one (DOCUMENT 14).
 *   - **Overdue**: DOCUMENT 13 rule 1 — `deadline < today` and the task is
 *     still open (`not_started`, `in_progress`, `on_hold`), with today the
 *     company's calendar day. Nothing else is called overdue.
 *   - **On time**: completed on or before the deadline's day, read in the
 *     company's zone (no deadline: on time). The rate is completed on time
 *     over completed, computed by the performance engine's own rate
 *     (`percentRate`), as is the completion rate.
 *
 * "By department" is the assignee's department. Aggregated by PostgreSQL;
 * rows are per employee, so bounded by headcount.
 */

import { Prisma } from '@ufuq/db';

import { instantAt } from '../../attendance/zoned-time.js';
import { percentRate } from '../../performance/performance-rules.js';
import { OPEN_STATUSES } from '../../tasks/task-rules.js';
import type { ReportRange } from '../report-range.js';
import {
  byPerson,
  employeesById,
  personColumns,
  rollUpByDepartment,
  scopedEmployeeIds,
} from '../report-people.js';
import { and, count, dateParam, slice } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

export interface TaskCountRow {
  readonly total: bigint;
  readonly assigned: bigint;
  readonly not_started: bigint;
  readonly in_progress: bigint;
  readonly on_hold: bigint;
  readonly completed: bigint;
  readonly cancelled: bigint;
  readonly overdue: bigint;
  readonly completed_on_time: bigint;
}

const COUNTS = [
  'assigned',
  'not_started',
  'in_progress',
  'on_hold',
  'completed',
  'cancelled',
  'overdue',
  'completed_on_time',
] as const;

/**
 * The counted columns over a `t` alias of tasks — shared with the monthly
 * snapshot's task summary. `todayKey` is the company's calendar day.
 */
export function taskCountsSql(todayKey: string, timeZone: string): Prisma.Sql {
  const open = Prisma.join(OPEN_STATUSES.map((status) => Prisma.sql`${status}`));
  return Prisma.sql`
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE t."status" <> 'cancelled') AS assigned,
    COUNT(*) FILTER (WHERE t."status" = 'not_started') AS not_started,
    COUNT(*) FILTER (WHERE t."status" = 'in_progress') AS in_progress,
    COUNT(*) FILTER (WHERE t."status" = 'on_hold') AS on_hold,
    COUNT(*) FILTER (WHERE t."status" = 'completed' AND t."completed_at" IS NOT NULL) AS completed,
    COUNT(*) FILTER (WHERE t."status" = 'cancelled') AS cancelled,
    COUNT(*) FILTER (
      WHERE t."deadline" < ${dateParam(todayKey)} AND t."status"::text IN (${open})
    ) AS overdue,
    COUNT(*) FILTER (
      WHERE t."status" = 'completed' AND t."completed_at" IS NOT NULL
        AND (t."deadline" IS NULL
             OR (t."completed_at" AT TIME ZONE ${timeZone})::date <= t."deadline")
    ) AS completed_on_time`;
}

export function taskCounts(row: TaskCountRow): Record<string, number | string | null> {
  const values = Object.fromEntries(COUNTS.map((key) => [key, count(row[key])])) as Record<
    (typeof COUNTS)[number],
    number
  >;
  return {
    ...values,
    completion_rate: percentRate(values.completed, values.assigned),
    on_time_rate: percentRate(values.completed_on_time, values.completed),
  };
}

/**
 * The tasks due in a range — by deadline, or by creation day when there is
 * none — over a `t` alias. Shared with the monthly snapshot.
 */
export function taskWindowSql(
  range: Pick<ReportRange, 'from' | 'to' | 'fromKey' | 'toKey'>,
  timeZone: string,
): Prisma.Sql {
  return Prisma.sql`t."deleted_at" IS NULL AND (
      t."deadline" BETWEEN ${dateParam(range.fromKey)} AND ${dateParam(range.toKey)}
      OR (t."deadline" IS NULL
          AND t."created_at" >= ${instantAt(range.from, 0, timeZone)}
          AND t."created_at" < ${instantAt(range.to, 24 * 60, timeZone)})
    )`;
}

export async function tasksReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const filters: Prisma.Sql[] = [
    taskWindowSql(range, qc.timeZone),
    Prisma.sql`t."assignee_employee_id" IN (${scopedEmployeeIds(qc)})`,
  ];
  if (qc.filters.status !== undefined) {
    filters.push(Prisma.sql`t."status" = ${qc.filters.status}::"task_status"`);
  }
  if (qc.filters.priority !== undefined) {
    filters.push(Prisma.sql`t."priority" = ${qc.filters.priority}::"task_priority"`);
  }

  // One scan: per assignee and per priority, in one GROUPING SETS aggregation.
  const grouped = await qc.tx.$queryRaw<
    (TaskCountRow & { employee_id: string | null; priority: string | null; by_priority: number })[]
  >`
    SELECT t."assignee_employee_id" AS employee_id, t."priority"::text AS priority,
           GROUPING(t."assignee_employee_id") AS by_priority,
           ${taskCountsSql(qc.todayKey, qc.timeZone)}
      FROM "tasks" t
     WHERE ${and(filters)}
     GROUP BY GROUPING SETS ((t."assignee_employee_id"), (t."priority"))`;

  const perEmployee = grouped.filter((row) => row.by_priority === 0);
  const people = await employeesById(
    qc,
    perEmployee.map((row) => row.employee_id as string),
  );
  const rows: ReportRow[] = perEmployee
    .map((row) => ({ ...personColumns(people.get(row.employee_id as string)), ...taskCounts(row) }))
    .sort(byPerson);
  const sums = Object.fromEntries(
    COUNTS.map((key) => [key, rows.reduce((sum, row) => sum + (row[key] as number), 0)]),
  ) as Record<(typeof COUNTS)[number], number>;

  return {
    summary: { employees: rows.length, ...sums, ...rates(sums) },
    groups: {
      by_department: rollUpByDepartment(rows, COUNTS).map((row) => ({
        ...row,
        ...rates(row as unknown as Record<(typeof COUNTS)[number], number>),
      })),
      by_priority: grouped
        .filter((row) => row.by_priority === 1)
        .sort(
          (a, b) =>
            PRIORITY_ORDER.indexOf(a.priority ?? '') - PRIORITY_ORDER.indexOf(b.priority ?? ''),
        )
        .map((row) => ({ priority: row.priority, ...taskCounts(row) })),
    },
    trend: [],
    rows: slice(rows, window),
    total: rows.length,
    provisional: false,
    provisionalReason: null,
    trendUnit: null,
  };
}

const PRIORITY_ORDER = ['low', 'medium', 'high', 'urgent'];

/** The engine's rates over a set of counts. */
function rates(values: Record<(typeof COUNTS)[number], number>): Record<string, string | null> {
  return {
    completion_rate: percentRate(values.completed, values.assigned),
    on_time_rate: percentRate(values.completed_on_time, values.completed),
  };
}
