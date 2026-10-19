/**
 * Company reports — DOCUMENT 08 §4.12, DOCUMENT 18.
 *
 * One path for every report:
 *
 *   1. **Scope** (`report-catalogue.ts`): company for `report.company`, the
 *      caller's team for `report.team` on a people report, 403 otherwise.
 *   2. **Filters** (`report-filters.ts`): only the ones the report takes;
 *      every id resolved inside the tenant (another company's: 404; an
 *      employee outside a manager's team: 403).
 *   3. **Range** (`report-range.ts`): the current month by default; longer
 *      than 12 months only with `confirm_large_range=true`.
 *   4. **Query** (`queries/*.ts`): aggregated by PostgreSQL, in one tenant
 *      transaction under row-level security, the scope inside the SQL.
 *   5. **Metadata**: key, scope, range, filters with their names, timezone,
 *      generation time and provisional state — the report states what it is.
 *
 * Reports are read-only (DOCUMENT 18 rule 5): this service writes nothing and
 * audits nothing (only exports and snapshot generation are audited).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@ufuq/db';

import { calendarDateIn, formatCalendarDate } from '../attendance/zoned-time.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { TenantScopedService } from '../company-structure/tenant-scoped.service.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

import type { ReportFiltersDto } from './dto/reports.dto.js';
import { attendanceReport } from './queries/attendance-report.js';
import { goalsReport } from './queries/goals-report.js';
import { inventoryReport } from './queries/inventory-report.js';
import { movementsReport } from './queries/movements-report.js';
import { payrollReport } from './queries/payroll-report.js';
import { performanceReport } from './queries/performance-report.js';
import { tasksReport } from './queries/tasks-report.js';
import { warehouseReport } from './queries/warehouse-report.js';
import { reportScope } from './report-catalogue.js';
import type { ReportKey, ReportScope } from './report-catalogue.js';
import { checkFilters, resolveFilterLabels } from './report-filters.js';
import { resolveRange } from './report-range.js';
import type {
  ReportMeta,
  ReportPayload,
  ReportQueryContext,
  ReportResult,
  RowWindow,
} from './report-types.js';

export type ReportQuery = (qc: ReportQueryContext, window: RowWindow) => Promise<ReportResult>;

export const REPORT_QUERIES: Readonly<Record<ReportKey, ReportQuery>> = {
  attendance: attendanceReport,
  performance: performanceReport,
  tasks: tasksReport,
  goals: goalsReport,
  payroll: payrollReport,
  inventory: inventoryReport,
  warehouse: warehouseReport,
  'stock-movements': movementsReport,
};

/** Reports with no date range: the state as it stands. */
const UNRANGED: readonly ReportKey[] = ['inventory'];

export interface PreparedReport {
  readonly qc: ReportQueryContext;
  /** The metadata block, without the query's provisional verdict. */
  readonly meta: Omit<ReportMeta, 'provisional' | 'provisional_reason' | 'trend_unit'>;
}

@Injectable()
export class ReportsService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  /** `GET /reports/{key}` — a page of rows with the whole set's summary. */
  async read(
    ctx: AuthContext,
    key: ReportKey,
    dto: ReportFiltersDto & { readonly confirm_large_range?: 'true' | 'false' | boolean },
    now: Date = new Date(),
  ): Promise<ReportPayload> {
    const scope = reportScope(ctx, key);
    const filters = checkFilters(key, dto);
    const page = resolvePage(dto);
    return this.tenant(ctx, async (tx) => {
      const prepared = await prepare(tx, key, scope, filters, dto, now);
      const result = await REPORT_QUERIES[key](prepared.qc, {
        offset: page.skip,
        limit: page.take,
      });
      return {
        report: finishMeta(prepared, result),
        summary: result.summary,
        groups: result.groups,
        trend: result.trend,
        rows: result.rows,
        pagination: {
          page: page.page,
          per_page: page.perPage,
          total: result.total,
          total_pages: Math.max(1, Math.ceil(result.total / page.perPage)),
        },
      };
    });
  }
}

/**
 * Resolve everything a query needs inside an open tenant transaction. Shared
 * with exports, so an export is exactly the report the caller could read.
 */
export async function prepare(
  tx: ReportQueryContext['tx'],
  key: ReportKey,
  scope: ReportScope,
  filters: ReturnType<typeof checkFilters>,
  dto: { readonly confirm_large_range?: 'true' | 'false' | boolean | undefined },
  now: Date,
): Promise<PreparedReport> {
  const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
  const today = calendarDateIn(now, company.timezone);
  const filterLabels = await resolveFilterLabels(tx, filters, scope);
  const range = UNRANGED.includes(key)
    ? null
    : resolveRange(
        {
          from: filters.from,
          to: filters.to,
          confirm_large_range:
            dto.confirm_large_range === true || dto.confirm_large_range === 'true',
        },
        today,
      );
  const rest = Object.fromEntries(
    Object.entries(filters).filter(([field]) => field !== 'from' && field !== 'to'),
  );
  return {
    qc: {
      tx,
      scope,
      filters,
      range,
      today,
      todayKey: formatCalendarDate(today),
      timeZone: company.timezone,
      now,
    },
    meta: {
      key,
      scope,
      range: range === null ? null : { from: range.fromKey, to: range.toKey },
      filters: rest,
      filter_labels: filterLabels,
      timezone: company.timezone,
      generated_at: now.toISOString(),
    },
  };
}

/**
 * The provisional verdict: the query's own (an unfinalized payroll) or, for a
 * range that reaches today or later, "the period has not ended" — its
 * figures will still move.
 */
export function finishMeta(prepared: PreparedReport, result: ReportResult): ReportMeta {
  const range = prepared.qc.range;
  const open = range !== null && range.toKey >= prepared.qc.todayKey;
  const provisional = result.provisional || open;
  return {
    ...prepared.meta,
    provisional,
    provisional_reason: result.provisionalReason ?? (open ? 'period_not_ended' : null),
    trend_unit: result.trendUnit,
  };
}
