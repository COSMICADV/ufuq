/**
 * Payroll report — DOCUMENT 18 "Company reports": gross, deductions, bonuses
 * and net by employee and period, with a month-over-month comparison.
 * `report.company` only: a MANAGER holds no salary access in V1 (OD-07).
 *
 * Payroll is never recalculated here. Every figure is the payroll module's
 * own stored truth:
 *
 *   - a row is a `payroll_lines` row: base (DOCUMENT 15's gross — the period's
 *     `total_gross` is the sum of the lines' base), attendance adjustment,
 *     deductions, bonuses and net exactly as stored; locked lines are the
 *     finalized, immutable figures;
 *   - post-finalization corrections are the appended `payroll_adjustments`,
 *     shown as `adjustments_total` and `adjusted_net` — the same derivation
 *     the payslip shows (DOCUMENT 15 rule 2);
 *   - a period that is not finalized, paid or adjusted is **provisional**, on
 *     the row and on the report.
 *
 * Periods are the months a range touches. Sums are exact NUMERIC sums in
 * PostgreSQL; rows are paginated by the database.
 */

import { Prisma } from '@ufuq/db';

import type { ReportRange } from '../report-range.js';
import {
  and,
  count,
  dateParam,
  decimalOf,
  employeeScopeSql,
  numeric,
  peopleFilterSql,
} from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

/** DOCUMENT 15: the states whose figures are final. */
export const FINAL_PAYROLL_STATUSES = ['finalized', 'paid', 'adjusted'] as const;

export function isFinalPayroll(status: string): boolean {
  return (FINAL_PAYROLL_STATUSES as readonly string[]).includes(status);
}

interface SumRow {
  readonly employees: bigint;
  readonly gross: Prisma.Decimal | null;
  readonly attendance_adjustment: Prisma.Decimal | null;
  readonly deductions: Prisma.Decimal | null;
  readonly bonuses: Prisma.Decimal | null;
  readonly net: Prisma.Decimal | null;
  readonly adjustments: Prisma.Decimal | null;
  readonly adjusted_net: Prisma.Decimal | null;
}

function sumsSql(): Prisma.Sql {
  return Prisma.sql`
    COUNT(DISTINCT l."employee_id") AS employees,
    SUM(l."base_salary") AS gross,
    SUM(l."attendance_adjustment") AS attendance_adjustment,
    SUM(l."total_deductions") AS deductions,
    SUM(l."total_bonuses") AS bonuses,
    SUM(l."net_salary") AS net,
    SUM(COALESCE(adj."total", 0)) AS adjustments,
    SUM(l."net_salary" + COALESCE(adj."total", 0)) AS adjusted_net`;
}

function sums(row: SumRow): Record<string, string | number> {
  return {
    employees: count(row.employees),
    gross: numeric(row.gross, 2),
    attendance_adjustment: numeric(row.attendance_adjustment, 2),
    deductions: numeric(row.deductions, 2),
    bonuses: numeric(row.bonuses, 2),
    net: numeric(row.net, 2),
    adjustments_total: numeric(row.adjustments, 2),
    adjusted_net: numeric(row.adjusted_net, 2),
  };
}

function linesCte(qc: ReportQueryContext, range: ReportRange): Prisma.Sql {
  const filters: Prisma.Sql[] = [
    Prisma.sql`p."start_date" <= ${dateParam(range.toKey)}`,
    Prisma.sql`p."end_date" >= ${dateParam(range.fromKey)}`,
  ];
  if (qc.filters.status !== undefined) {
    filters.push(Prisma.sql`p."status" = ${qc.filters.status}::"payroll_period_status"`);
  }
  return Prisma.sql`
    WITH scoped AS (
      SELECT e."id", e."first_name", e."last_name", e."employee_code", e."department_id"
        FROM "employees" e
       WHERE ${employeeScopeSql(qc.scope, 'e')} AND ${peopleFilterSql(qc.filters, 'e')}
    ),
    l AS (
      SELECT l.*, p."year", p."month", p."status"::text AS period_status
        FROM "payroll_lines" l
        JOIN "payroll_periods" p ON p."id" = l."payroll_period_id"
        JOIN scoped s ON s."id" = l."employee_id"
       WHERE ${and(filters)}
    ),
    adj AS (
      SELECT a."original_payroll_line_id" AS line_id, SUM(a."amount") AS total
        FROM "payroll_adjustments" a
        JOIN l ON l."id" = a."original_payroll_line_id"
       GROUP BY a."original_payroll_line_id"
    )`;
}

function periodLabel(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

export async function payrollReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const cte = linesCte(qc, range);

  const [totals] = await qc.tx.$queryRaw<(SumRow & { lines: bigint })[]>`${cte}
    SELECT COUNT(*) AS lines, ${sumsSql()}
      FROM l LEFT JOIN adj ON adj."line_id" = l."id"`;

  const periods = await qc.tx.$queryRaw<
    (SumRow & { period_id: string; year: number; month: number; status: string })[]
  >`${cte}
    SELECT l."payroll_period_id" AS period_id, l."year", l."month", l."period_status" AS status,
           ${sumsSql()}
      FROM l LEFT JOIN adj ON adj."line_id" = l."id"
     GROUP BY l."payroll_period_id", l."year", l."month", l."period_status"
     ORDER BY l."year", l."month"`;

  const paging =
    window === 'all' ? Prisma.empty : Prisma.sql`LIMIT ${window.limit} OFFSET ${window.offset}`;
  const lines = await qc.tx.$queryRaw<
    {
      line_id: string;
      period_id: string;
      year: number;
      month: number;
      period_status: string;
      employee_id: string;
      first_name: string;
      last_name: string;
      employee_code: string;
      base_salary: Prisma.Decimal;
      attendance_adjustment: Prisma.Decimal;
      total_deductions: Prisma.Decimal;
      total_bonuses: Prisma.Decimal;
      net_salary: Prisma.Decimal;
      adjustments: Prisma.Decimal | null;
      is_locked: boolean;
    }[]
  >`${cte}
    SELECT l."id" AS line_id, l."payroll_period_id" AS period_id, l."year", l."month",
           l."period_status", s."id" AS employee_id, s."first_name", s."last_name",
           s."employee_code", l."base_salary", l."attendance_adjustment", l."total_deductions",
           l."total_bonuses", l."net_salary", adj."total" AS adjustments, l."is_locked"
      FROM l
      JOIN scoped s ON s."id" = l."employee_id"
      LEFT JOIN adj ON adj."line_id" = l."id"
     ORDER BY l."year", l."month", s."first_name", s."last_name", l."id"
     ${paging}`;

  const rows: ReportRow[] = lines.map((line) => {
    const net = decimalOf(line.net_salary, 2);
    const adjustments = decimalOf(line.adjustments, 2);
    return {
      line_id: line.line_id,
      period_id: line.period_id,
      period: periodLabel(line.year, line.month),
      period_status: line.period_status,
      provisional: !isFinalPayroll(line.period_status),
      employee_id: line.employee_id,
      employee_name: `${line.first_name} ${line.last_name}`,
      employee_code: line.employee_code,
      gross: numeric(line.base_salary, 2),
      attendance_adjustment: numeric(line.attendance_adjustment, 2),
      deductions: numeric(line.total_deductions, 2),
      bonuses: numeric(line.total_bonuses, 2),
      net: net.toString(),
      adjustments_total: adjustments.toString(),
      adjusted_net: net.add(adjustments).toString(),
      is_locked: line.is_locked,
    };
  });

  // Month over month: each period against the one before it in the list.
  const byPeriod: ReportRow[] = [];
  let previous: string | null = null;
  for (const period of periods) {
    const values = sums(period);
    const adjustedNet = values.adjusted_net as string;
    byPeriod.push({
      period_id: period.period_id,
      period: periodLabel(period.year, period.month),
      status: period.status,
      provisional: !isFinalPayroll(period.status),
      ...values,
      adjusted_net_change:
        previous === null
          ? null
          : decimalOf(adjustedNet, 2).subtract(decimalOf(previous, 2)).toString(),
    });
    previous = adjustedNet;
  }
  const provisional = periods.some((period) => !isFinalPayroll(period.status));

  const summaryRow = totals as SumRow & { lines: bigint };
  return {
    summary: { lines: count(summaryRow.lines), periods: periods.length, ...sums(summaryRow) },
    groups: { by_period: byPeriod },
    trend: periods.map((period) => ({
      period: periodLabel(period.year, period.month),
      values: {
        gross: numeric(period.gross, 2),
        net: numeric(period.net, 2),
        adjusted_net: numeric(period.adjusted_net, 2),
      },
    })),
    rows,
    total: count(summaryRow.lines),
    provisional,
    provisionalReason: provisional ? 'payroll_not_finalized' : null,
    trendUnit: 'month',
  };
}
