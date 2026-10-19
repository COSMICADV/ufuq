/**
 * The shape every company report answers in — DOCUMENT 18 rules 4–7.
 *
 * A report is self-describing: the payload states its key, its scope (so a
 * manager's team report cannot be mistaken for a company one), the date range
 * and every active filter with the names they refer to, when it was produced
 * and in which timezone, and whether its figures are provisional. Exports
 * and printed reports carry the same block.
 *
 * Rows are paginated (rule 6); summaries, groups and trends are aggregated by
 * the database over the whole filtered set, never over one page.
 */

import { Prisma } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import type { CalendarDate } from '../attendance/zoned-time.js';

import type { ReportKey, ReportScope } from './report-catalogue.js';
import type { ActiveFilters, FilterField, FilterLabel } from './report-filters.js';
import type { ReportRange } from './report-range.js';

export type Cell = string | number | boolean | null;
export type ReportRow = Readonly<Record<string, Cell>>;

export interface TrendPoint {
  /** `YYYY-MM-DD` for a daily trend, `YYYY-MM` for a monthly one. */
  readonly period: string;
  readonly values: Readonly<Record<string, Cell>>;
}

export interface ReportMeta {
  readonly key: ReportKey;
  readonly scope: ReportScope;
  /** Null for a report that is the state as it stands (inventory). */
  readonly range: { readonly from: string; readonly to: string } | null;
  /** The filters applied besides the range, as sent. */
  readonly filters: Readonly<Omit<ActiveFilters, 'from' | 'to'>>;
  /** What the id filters refer to, in both languages. */
  readonly filter_labels: Readonly<Partial<Record<FilterField, FilterLabel>>>;
  readonly timezone: string;
  readonly generated_at: string;
  /** Some figure may still change (an unfinalized payroll, a month not yet ended). */
  readonly provisional: boolean;
  readonly provisional_reason: string | null;
  readonly trend_unit: 'day' | 'month' | null;
}

export interface ReportPagination {
  readonly page: number;
  readonly per_page: number;
  readonly total: number;
  readonly total_pages: number;
}

export interface ReportPayload {
  readonly report: ReportMeta;
  readonly summary: Readonly<Record<string, Cell>>;
  /** Named breakdowns: `by_department`, `by_period`, `by_category`, … */
  readonly groups: Readonly<Record<string, readonly ReportRow[]>>;
  readonly trend: readonly TrendPoint[];
  readonly rows: readonly ReportRow[];
  readonly pagination: ReportPagination;
}

/** Everything a report query needs, resolved once by the service. */
export interface ReportQueryContext {
  readonly tx: TenantClient;
  readonly scope: ReportScope;
  readonly filters: ActiveFilters;
  readonly range: ReportRange | null;
  readonly today: CalendarDate;
  readonly todayKey: string;
  readonly timeZone: string;
  readonly now: Date;
}

/** A page of rows, or every row (an export). */
export type RowWindow = { readonly offset: number; readonly limit: number } | 'all';

/** What a report query returns; the service wraps it with the metadata. */
export interface ReportResult {
  readonly summary: Readonly<Record<string, Cell>>;
  readonly groups: Readonly<Record<string, readonly ReportRow[]>>;
  readonly trend: readonly TrendPoint[];
  readonly rows: readonly ReportRow[];
  readonly total: number;
  readonly provisional: boolean;
  readonly provisionalReason: string | null;
  readonly trendUnit: 'day' | 'month' | null;
}

/**
 * The scope as SQL over an `employees` alias: nothing for a company reader,
 * `manager_id = caller` for a team reader — resolved in the query itself,
 * never by fetching the company and discarding rows (DOCUMENT 02 §5.3).
 */
export function employeeScopeSql(scope: ReportScope, alias: string): Prisma.Sql {
  const column = Prisma.raw(`${alias}."manager_id"`);
  return scope.type === 'company'
    ? Prisma.sql`TRUE`
    : Prisma.sql`${column} = ${scope.manager_employee_id}::uuid`;
}

/** The department and employee filters over an `employees` alias. */
export function peopleFilterSql(filters: ActiveFilters, alias: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filters.department_id !== undefined) {
    parts.push(
      Prisma.sql`${Prisma.raw(`${alias}."department_id"`)} = ${filters.department_id}::uuid`,
    );
  }
  if (filters.employee_id !== undefined) {
    parts.push(Prisma.sql`${Prisma.raw(`${alias}."id"`)} = ${filters.employee_id}::uuid`);
  }
  return parts.length === 0 ? Prisma.sql`TRUE` : Prisma.join(parts, ' AND ');
}

/** `a AND b AND …`, with `TRUE` for nothing. */
export function and(parts: readonly Prisma.Sql[]): Prisma.Sql {
  return parts.length === 0 ? Prisma.sql`TRUE` : Prisma.join(parts, ' AND ');
}

/** A `@db.Date` parameter for a calendar day. */
export function dateParam(day: string): Prisma.Sql {
  return Prisma.sql`${day}::date`;
}

/** `COUNT(*)` comes back from PostgreSQL as a bigint; counts here are small. */
export function count(value: bigint | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * A NUMERIC from a raw query as its exact string at `scale` places. The SQL
 * has already rounded (or kept the column's scale), so this only pads; a
 * value with more places is an error, never a silent truncation.
 */
export function numeric(value: Prisma.Decimal | string | null | undefined, scale: number): string {
  if (value === null || value === undefined) {
    return Decimal.zero(scale).toString();
  }
  return Decimal.parse(value.toString(), scale).toString();
}

export function decimalOf(
  value: Prisma.Decimal | string | null | undefined,
  scale: number,
): Decimal {
  return Decimal.parse(numeric(value, scale), scale);
}

export function slice<T>(rows: readonly T[], window: RowWindow): readonly T[] {
  return window === 'all' ? rows : rows.slice(window.offset, window.offset + window.limit);
}

/** A person's display name as reports show it. */
export function personName(row: {
  readonly first_name: string;
  readonly last_name: string;
}): string {
  return `${row.first_name} ${row.last_name}`;
}
