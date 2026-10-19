/**
 * Attendance report — DOCUMENT 18 "Company reports": present, absent, late,
 * WFH, office and leave by employee and department over a date range, with a
 * trend.
 *
 * Source: `attendance_records`, read as written. Every count is a count of
 * stored records by their stored status — historical statuses are never
 * re-derived from today's schedule (DOCUMENT 12 "schedule changes mid-month":
 * the record holds what was decided for that day). Hence:
 *
 *   - **working days**: records whose status is not `weekend` or `holiday`;
 *   - **present**: the attended statuses (`present`, `late`, `half_day`,
 *     `pending`) — the same set the performance engine counts as attended;
 *   - **office / WFH**: attended records by their work mode;
 *   - **late**: `late` records (a late day is also a present day);
 *   - **absent**: `absent`; **leave**: `on_leave`.
 *
 * Days with no record yet (today, before the nightly job) are not counted.
 * Aggregated by PostgreSQL; rows are per employee, so bounded by headcount.
 */

import { Prisma } from '@ufuq/db';

import { ATTENDED_STATUSES } from '../../performance/performance-month.js';
import { trendUnit } from '../report-range.js';
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

/**
 * The counted columns, as SQL aggregates over an `r` alias of attendance
 * records — shared with the monthly snapshot's attendance summary.
 */
export function attendanceCountsSql(): Prisma.Sql {
  const attended = Prisma.join(ATTENDED_STATUSES.map((status) => Prisma.sql`${status}`));
  return Prisma.sql`
    COUNT(*) FILTER (WHERE r."status" NOT IN ('weekend', 'holiday')) AS working_days,
    COUNT(*) FILTER (WHERE r."status"::text IN (${attended})) AS present,
    COUNT(*) FILTER (WHERE r."status"::text IN (${attended}) AND r."work_mode" = 'office') AS office,
    COUNT(*) FILTER (WHERE r."status"::text IN (${attended}) AND r."work_mode" = 'wfh') AS wfh,
    COUNT(*) FILTER (WHERE r."status" = 'late') AS late,
    COUNT(*) FILTER (WHERE r."status" = 'half_day') AS half_day,
    COUNT(*) FILTER (WHERE r."status" = 'absent') AS absent,
    COUNT(*) FILTER (WHERE r."status" = 'on_leave') AS leave,
    COUNT(*) AS recorded_days`;
}

export interface AttendanceCountRow {
  readonly working_days: bigint;
  readonly present: bigint;
  readonly office: bigint;
  readonly wfh: bigint;
  readonly late: bigint;
  readonly half_day: bigint;
  readonly absent: bigint;
  readonly leave: bigint;
  readonly recorded_days: bigint;
}

const COUNTS = [
  'working_days',
  'present',
  'office',
  'wfh',
  'late',
  'half_day',
  'absent',
  'leave',
  'recorded_days',
] as const;

export function attendanceCounts(row: AttendanceCountRow): Record<(typeof COUNTS)[number], number> {
  return Object.fromEntries(COUNTS.map((key) => [key, count(row[key])])) as Record<
    (typeof COUNTS)[number],
    number
  >;
}

/**
 * One scan of the records: counts per employee and per trend bucket in a
 * single `GROUPING SETS` aggregation. The scope is a semi-join on the
 * employees in scope, resolved inside the SQL.
 */
export async function attendanceReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const recordFilters: Prisma.Sql[] = [
    Prisma.sql`r."date" BETWEEN ${dateParam(range.fromKey)} AND ${dateParam(range.toKey)}`,
    Prisma.sql`r."employee_id" IN (${scopedEmployeeIds(qc)})`,
  ];
  if (qc.filters.status !== undefined) {
    recordFilters.push(Prisma.sql`r."status" = ${qc.filters.status}::"attendance_status"`);
  }
  if (qc.filters.work_mode !== undefined) {
    recordFilters.push(Prisma.sql`r."work_mode" = ${qc.filters.work_mode}::"work_mode"`);
  }
  const unit = trendUnit(range);
  const bucket =
    unit === 'day'
      ? Prisma.sql`to_char(r."date", 'YYYY-MM-DD')`
      : Prisma.sql`to_char(r."date", 'YYYY-MM')`;

  const grouped = await qc.tx.$queryRaw<
    (AttendanceCountRow & {
      employee_id: string | null;
      period: string | null;
      by_period: number;
    })[]
  >`
    SELECT r."employee_id", ${bucket} AS period, GROUPING(r."employee_id") AS by_period,
           ${attendanceCountsSql()}
      FROM "attendance_records" r
     WHERE ${and(recordFilters)}
     GROUP BY GROUPING SETS ((r."employee_id"), (${bucket}))`;

  const perEmployee = grouped.filter((row) => row.by_period === 0);
  const people = await employeesById(
    qc,
    perEmployee.map((row) => row.employee_id as string),
  );
  const rows: ReportRow[] = perEmployee
    .map((row) => ({
      ...personColumns(people.get(row.employee_id as string)),
      ...attendanceCounts(row),
    }))
    .sort(byPerson);
  const totals = Object.fromEntries(
    COUNTS.map((key) => [key, rows.reduce((sum, row) => sum + (row[key] as number), 0)]),
  );

  return {
    summary: { employees: rows.length, ...totals },
    groups: { by_department: rollUpByDepartment(rows, COUNTS) },
    trend: grouped
      .filter((row) => row.by_period === 1)
      .sort((a, b) => ((a.period ?? '') < (b.period ?? '') ? -1 : 1))
      .map((row) => ({
        period: row.period as string,
        values: {
          present: count(row.present),
          wfh: count(row.wfh),
          late: count(row.late),
          absent: count(row.absent),
          leave: count(row.leave),
        },
      })),
    rows: slice(rows, window),
    total: rows.length,
    provisional: false,
    provisionalReason: null,
    trendUnit: unit,
  };
}
