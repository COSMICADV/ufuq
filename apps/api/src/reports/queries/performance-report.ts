/**
 * Employee performance report — DOCUMENT 18 "Company reports": attendance,
 * task, goal and overall scores per employee; department comparison.
 *
 * No score is computed here. Every figure comes from `monthlyPerformance`
 * (`performance/performance-month.ts`) — the one calculation behind
 * `GET /employees/{id}/performance` and the monthly snapshots — with the
 * company's configuration, so missing components are excluded and the
 * weights renormalised exactly as the performance module does (DOCUMENT 14
 * "Employees with no data"). A component with no data is `null`, never 0%.
 *
 * Performance is defined per calendar month (DOCUMENT 14), so a range is read
 * as the months it touches (up to the current one, which is provisional):
 * one row per employee per month. The department comparison is the mean of
 * the overall scores that exist in each department and month — an average
 * of the canonical scores, not a rescoring.
 *
 * Employees: not deleted, employed during the month, in the caller's scope.
 */

import type { Prisma } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { dateValue as calendarDateValue } from '../../attendance/attendance-query.js';
import { compareDates } from '../../attendance/zoned-time.js';
import {
  loadConfigRow,
  monthlyPerformance,
  PERFORMANCE_SUBJECT_SELECT,
} from '../../performance/performance-month.js';
import type { Month } from '../../performance/performance-month.js';
import { monthsIn } from '../report-range.js';
import type { ReportRange } from '../report-range.js';
import { slice } from '../report-types.js';
import type { ReportQueryContext, ReportResult, ReportRow, RowWindow } from '../report-types.js';

const SCORE_SCALE = 2;

function employeeWhere(qc: ReportQueryContext, month: Month): Prisma.EmployeeWhereInput {
  return {
    AND: [
      { deletedAt: null },
      qc.scope.type === 'team' ? { managerId: qc.scope.manager_employee_id } : {},
      qc.filters.department_id === undefined ? {} : { departmentId: qc.filters.department_id },
      qc.filters.employee_id === undefined ? {} : { id: qc.filters.employee_id },
      qc.filters.status === undefined
        ? {}
        : { status: qc.filters.status as 'active' | 'inactive' | 'terminated' },
      { joiningDate: { lte: calendarDateValue(month.last) } },
      {
        OR: [
          { terminationDate: null },
          { terminationDate: { gte: calendarDateValue(month.first) } },
        ],
      },
    ],
  };
}

/** The mean of the scores present, to the hundredth; null when none is. */
function mean(scores: readonly (string | null)[]): string | null {
  const present = scores.filter((score): score is string => score !== null);
  if (present.length === 0) return null;
  return Decimal.sum(
    present.map((score) => Decimal.parse(score, SCORE_SCALE)),
    SCORE_SCALE,
  )
    .divideByInteger(present.length, 'nearest')
    .toString();
}

export async function performanceReport(
  qc: ReportQueryContext,
  window: RowWindow,
): Promise<ReportResult> {
  const range = qc.range as ReportRange;
  const months = monthsIn(range, qc.today);
  const configRow = await loadConfigRow(qc.tx);

  const rows: ReportRow[] = [];
  const departments: ReportRow[] = [];
  for (const month of months) {
    const employees = await qc.tx.employee.findMany({
      where: employeeWhere(qc, month),
      select: {
        ...PERFORMANCE_SUBJECT_SELECT,
        firstName: true,
        lastName: true,
        employeeCode: true,
        departmentId: true,
        department: { select: { nameAr: true, nameEn: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
    const scores = await monthlyPerformance(
      qc.tx,
      employees,
      month,
      qc.today,
      qc.timeZone,
      configRow,
    );
    const byDepartment = new Map<
      string,
      { id: string | null; ar: string | null; en: string | null; overall: (string | null)[] }
    >();
    for (const employee of employees) {
      const score = scores.get(employee.id);
      if (score === undefined) continue;
      rows.push({
        month: month.key,
        provisional: score.is_provisional,
        employee_id: employee.id,
        employee_name: `${employee.firstName} ${employee.lastName}`,
        employee_code: employee.employeeCode,
        department_id: employee.departmentId,
        department_name_ar: employee.department?.nameAr ?? null,
        department_name_en: employee.department?.nameEn ?? null,
        attendance_score: score.components.attendance.score,
        attendance_no_data_reason: score.components.attendance.no_data_reason,
        task_score: score.components.task.score,
        goal_score: score.components.goal.score,
        overall: score.overall,
        attendance_weight: score.components.attendance.effective_weight,
        task_weight: score.components.task.effective_weight,
        goal_weight: score.components.goal.effective_weight,
      });
      const key = employee.departmentId ?? '';
      let group = byDepartment.get(key);
      if (group === undefined) {
        group = {
          id: employee.departmentId,
          ar: employee.department?.nameAr ?? null,
          en: employee.department?.nameEn ?? null,
          overall: [],
        };
        byDepartment.set(key, group);
      }
      group.overall.push(score.overall);
    }
    for (const group of byDepartment.values()) {
      departments.push({
        month: month.key,
        department_id: group.id,
        department_name_ar: group.ar,
        department_name_en: group.en,
        employees: group.overall.length,
        employees_with_score: group.overall.filter((score) => score !== null).length,
        average_overall: mean(group.overall),
      });
    }
  }

  const config = (configRow.config ?? {}) as Prisma.JsonObject;
  const last = months.at(-1);
  const provisional = last !== undefined && compareDates(last.last, qc.today) >= 0;
  return {
    summary: {
      months: months.length,
      rows: rows.length,
      employees_with_score: rows.filter((row) => row.overall !== null).length,
      average_overall: mean(rows.map((row) => row.overall as string | null)),
      // The weights in effect — DOCUMENT 14: a report must be explicable.
      weights: JSON.stringify(config['weights'] ?? null),
    },
    groups: { by_department: departments },
    trend: months.map((month) => ({
      period: month.key,
      values: {
        average_overall: mean(
          rows.filter((row) => row.month === month.key).map((row) => row.overall as string | null),
        ),
      },
    })),
    rows: slice(rows, window),
    total: rows.length,
    provisional,
    provisionalReason: provisional ? 'month_not_ended' : null,
    trendUnit: 'month',
  };
}
