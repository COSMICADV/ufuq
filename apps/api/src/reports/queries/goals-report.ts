/**
 * Goal report — DOCUMENT 18 "Company reports": goal progress by employee,
 * type and period; achievement rate.
 *
 * Source: `goals` as the goal module keeps them. Progress is the module's
 * own measure (`goalMeasures`: the current value over the effective target,
 * pro-rated for a termination, the **true** percentage — DOCUMENT 14 rule 1,
 * so over-achievement shows), and task goals' current values are the ones the
 * goal module derives from their tasks. Nothing is re-derived here, so a row
 * equals what `GET /goals/{id}` says.
 *
 *   - **Which goals**: not deleted, period overlapping the range.
 *   - **Achievement rate**: achieved ÷ (achieved + missed) × 100 — the goals
 *     whose outcome is decided (the period-end job's statuses). Active and
 *     cancelled goals have no outcome yet / none to count.
 *
 * Counts are aggregated by PostgreSQL; the rows (one per goal) are paginated
 * by the database.
 */

import { Prisma } from '@ufuq/db';

import { goalMeasures, valueToWire } from '../../goals/goal-payload.js';
import { dateToWire } from '../../attendance/attendance-payload.js';
import { percentRate } from '../../performance/performance-rules.js';
import type { ReportRange } from '../report-range.js';
import { and, count, dateParam, employeeScopeSql, peopleFilterSql } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

interface CountRow {
  readonly total: bigint;
  readonly active: bigint;
  readonly achieved: bigint;
  readonly missed: bigint;
  readonly cancelled: bigint;
}

function countsSql(): Prisma.Sql {
  return Prisma.sql`
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE g."status" = 'active') AS active,
    COUNT(*) FILTER (WHERE g."status" = 'achieved') AS achieved,
    COUNT(*) FILTER (WHERE g."status" = 'missed') AS missed,
    COUNT(*) FILTER (WHERE g."status" = 'cancelled') AS cancelled`;
}

function counts(row: CountRow): Record<string, number | string | null> {
  const achieved = count(row.achieved);
  const missed = count(row.missed);
  return {
    goals: count(row.total),
    active: count(row.active),
    achieved,
    missed,
    cancelled: count(row.cancelled),
    achievement_rate: percentRate(achieved, achieved + missed),
  };
}

function goalsCte(qc: ReportQueryContext, range: ReportRange): Prisma.Sql {
  const filters: Prisma.Sql[] = [
    Prisma.sql`g."deleted_at" IS NULL`,
    Prisma.sql`g."period_start" <= ${dateParam(range.toKey)}`,
    Prisma.sql`g."period_end" >= ${dateParam(range.fromKey)}`,
  ];
  if (qc.filters.status !== undefined) {
    filters.push(Prisma.sql`g."status" = ${qc.filters.status}::"goal_status"`);
  }
  if (qc.filters.goal_type !== undefined) {
    filters.push(Prisma.sql`g."type" = ${qc.filters.goal_type}::"goal_type"`);
  }
  return Prisma.sql`
    WITH scoped AS (
      SELECT e."id", e."first_name", e."last_name", e."employee_code", e."department_id",
             e."termination_date"
        FROM "employees" e
       WHERE ${employeeScopeSql(qc.scope, 'e')} AND ${peopleFilterSql(qc.filters, 'e')}
    ),
    g AS (
      SELECT g.*
        FROM "goals" g
        JOIN scoped s ON s."id" = g."employee_id"
       WHERE ${and(filters)}
    )`;
}

export async function goalsReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const cte = goalsCte(qc, range);

  const [totals] = await qc.tx.$queryRaw<CountRow[]>`${cte} SELECT ${countsSql()} FROM g`;

  const byType = await qc.tx.$queryRaw<(CountRow & { type: string })[]>`${cte}
    SELECT g."type"::text AS type, ${countsSql()} FROM g GROUP BY g."type" ORDER BY g."type"`;

  const byEmployee = await qc.tx.$queryRaw<
    (CountRow & {
      employee_id: string;
      first_name: string;
      last_name: string;
      employee_code: string;
    })[]
  >`${cte}
    SELECT s."id" AS employee_id, s."first_name", s."last_name", s."employee_code", ${countsSql()}
      FROM g JOIN scoped s ON s."id" = g."employee_id"
     GROUP BY s."id", s."first_name", s."last_name", s."employee_code"
     ORDER BY s."first_name", s."last_name", s."id"`;

  const byPeriod = await qc.tx.$queryRaw<(CountRow & { period: string })[]>`${cte}
    SELECT to_char(g."period_end", 'YYYY-MM') AS period, ${countsSql()}
      FROM g GROUP BY 1 ORDER BY 1`;

  const paging =
    window === 'all' ? Prisma.empty : Prisma.sql`LIMIT ${window.limit} OFFSET ${window.offset}`;
  const goals = await qc.tx.$queryRaw<
    {
      id: string;
      title: string;
      type: string;
      status: string;
      unit: string;
      target_value: Prisma.Decimal;
      current_value: Prisma.Decimal;
      period_start: Date;
      period_end: Date;
      employee_id: string;
      first_name: string;
      last_name: string;
      employee_code: string;
      termination_date: Date | null;
    }[]
  >`${cte}
    SELECT g."id", g."title", g."type"::text AS type, g."status"::text AS status, g."unit",
           g."target_value", g."current_value", g."period_start", g."period_end",
           s."id" AS employee_id, s."first_name", s."last_name", s."employee_code",
           s."termination_date"
      FROM g JOIN scoped s ON s."id" = g."employee_id"
     ORDER BY g."period_end", s."first_name", s."last_name", g."id"
     ${paging}`;

  const rows: ReportRow[] = goals.map((goal) => {
    const measures = goalMeasures({
      targetValue: goal.target_value,
      currentValue: goal.current_value,
      periodStart: goal.period_start,
      periodEnd: goal.period_end,
      employee: { terminationDate: goal.termination_date },
    });
    return {
      goal_id: goal.id,
      title: goal.title,
      type: goal.type,
      status: goal.status,
      employee_id: goal.employee_id,
      employee_name: `${goal.first_name} ${goal.last_name}`,
      employee_code: goal.employee_code,
      period_start: dateToWire(goal.period_start),
      period_end: dateToWire(goal.period_end),
      unit: goal.unit,
      target_value: valueToWire(goal.target_value),
      effective_target_value: measures.effectiveTarget,
      current_value: valueToWire(goal.current_value),
      progress_percent: measures.progressPercent,
    };
  });

  const summary = counts(totals as CountRow);
  return {
    summary,
    groups: {
      by_type: byType.map((row) => ({ type: row.type, ...counts(row) })),
      by_employee: byEmployee.map((row) => ({
        employee_id: row.employee_id,
        employee_name: `${row.first_name} ${row.last_name}`,
        employee_code: row.employee_code,
        ...counts(row),
      })),
      by_period: byPeriod.map((row) => ({ period: row.period, ...counts(row) })),
    },
    trend: [],
    rows,
    total: summary.goals as number,
    provisional: false,
    provisionalReason: null,
    trendUnit: null,
  };
}
