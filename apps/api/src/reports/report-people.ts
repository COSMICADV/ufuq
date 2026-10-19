/**
 * The people side of the people reports (attendance, tasks) — shared, so the
 * reports scope, name and group employees identically.
 *
 * The heavy aggregation (records, tasks) happens in PostgreSQL first; the
 * result is at most one row per employee in scope. Names are then read for
 * those rows in one query, and the department breakdown is summed from them
 * — a roll-up of headcount-bounded rows, never a loop over source records.
 */

import { Prisma } from '@ufuq/db';

import { and, employeeScopeSql, peopleFilterSql } from './report-types.js';
import type { Cell, ReportQueryContext, ReportRow } from './report-types.js';

/**
 * The ids of the employees in scope and matching the people filters, as a
 * subquery for `… IN (…)` — the scope lives inside the SQL (DOCUMENT 02 §5.3).
 */
export function scopedEmployeeIds(qc: ReportQueryContext): Prisma.Sql {
  return Prisma.sql`SELECT e."id" FROM "employees" e
    WHERE ${and([employeeScopeSql(qc.scope, 'e'), peopleFilterSql(qc.filters, 'e')])}`;
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly departmentId: string | null;
  readonly departmentAr: string | null;
  readonly departmentEn: string | null;
}

/** The named employees, in one query whatever their number. */
export async function employeesById(
  qc: ReportQueryContext,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Person>> {
  if (ids.length === 0) return new Map();
  const rows = await qc.tx.employee.findMany({
    where: { id: { in: [...ids] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      departmentId: true,
      department: { select: { nameAr: true, nameEn: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        name: `${row.firstName} ${row.lastName}`,
        code: row.employeeCode,
        departmentId: row.departmentId,
        departmentAr: row.department?.nameAr ?? null,
        departmentEn: row.department?.nameEn ?? null,
      },
    ]),
  );
}

export function personColumns(person: Person | undefined): Record<string, Cell> {
  if (person === undefined) {
    throw new Error('An aggregated row names an employee that could not be read');
  }
  return {
    employee_id: person.id,
    employee_name: person.name,
    employee_code: person.code,
    department_id: person.departmentId,
    department_name_ar: person.departmentAr,
    department_name_en: person.departmentEn,
  };
}

/** By name, then id — a stable order for paging. */
export function byPerson(a: ReportRow, b: ReportRow): number {
  const an = a.employee_name as string;
  const bn = b.employee_name as string;
  if (an !== bn) return an < bn ? -1 : 1;
  return (a.employee_id as string) < (b.employee_id as string) ? -1 : 1;
}

/** Sum each count over each department's employee rows. */
export function rollUpByDepartment(
  rows: readonly ReportRow[],
  counts: readonly string[],
): ReportRow[] {
  const groups = new Map<
    string,
    { head: ReportRow; sums: Record<string, number>; employees: number }
  >();
  for (const row of rows) {
    const key = (row.department_id as string | null) ?? '';
    let group = groups.get(key);
    if (group === undefined) {
      group = { head: row, sums: Object.fromEntries(counts.map((c) => [c, 0])), employees: 0 };
      groups.set(key, group);
    }
    group.employees += 1;
    for (const c of counts) group.sums[c] = (group.sums[c] ?? 0) + (row[c] as number);
  }
  return [...groups.values()]
    .map((group) => ({
      department_id: group.head.department_id ?? null,
      department_name_ar: group.head.department_name_ar ?? null,
      department_name_en: group.head.department_name_en ?? null,
      employees: group.employees,
      ...group.sums,
    }))
    .sort((a, b) => {
      const an = a.department_name_en as string | null;
      const bn = b.department_name_en as string | null;
      if (an === bn) return 0;
      if (an === null) return 1;
      if (bn === null) return -1;
      return an < bn ? -1 : 1;
    });
}
