/**
 * Report exports — DOCUMENT 08 §4.12 `POST /reports/{key}/export`,
 * DOCUMENT 18 "Export & print", "Performance" and "Error states".
 *
 * **Authorisation** (`exportScope`): `report.export` *and* the right to read
 * the report. A MANAGER's export grant never opens payroll, inventory,
 * warehouse or the stock ledger, and a manager's export holds exactly their
 * team's rows — the same scoped query the screen runs (`prepare`).
 *
 * **Size** decides the path, never the caller:
 *
 *   - up to `syncMaxRows` rows: the CSV is produced in the request and
 *     returned (`200 text/csv`);
 *   - more: a `report_exports` row is queued and the work runs as a
 *     background job (`202` with the export's id). The job writes the file to
 *     private object storage; the requester polls `GET /reports/exports/{id}`
 *     and downloads it. Completion and failure are published as events —
 *     the in-app notification itself is Phase 15's;
 *   - more than `maxRows`: 422 `REPORT_EXPORT_TOO_LARGE` — narrow the filters.
 *     Memory is therefore bounded by `maxRows`, and the ledger is read in
 *     keyset batches, never in one query.
 *
 * **Audit**: every successful export is `report.exported`, with the report
 * key, filters and scope, written after the work is done (post-commit, via
 * `AuditDispatcher.dispatch`); a failed export writes none.
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId, withTenant } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import type { Locale } from '@ufuq/i18n';

import { OBJECT_STORAGE } from '../attachments/object-storage.js';
import type { ObjectStorage } from '../attachments/object-storage.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { notFound } from '../company-structure/tenant-scoped.service.js';

import { CSV_BOM, csvHeader, csvPreamble, csvRows } from './csv.js';
import type { ExportReportDto } from './dto/reports.dto.js';
import { movementBatches } from './queries/movements-report.js';
import type { TenantRun } from './queries/movements-report.js';
import { exportScope } from './report-catalogue.js';
import type { ReportKey, ReportScope } from './report-catalogue.js';
import { reportColumns, reportPreamble } from './report-columns.js';
import { ReportEventPublisher } from './report-events.js';
import { checkFilters } from './report-filters.js';
import type { ActiveFilters } from './report-filters.js';
import type { ReportMeta, ReportResult } from './report-types.js';
import { finishMeta, prepare, REPORT_QUERIES } from './reports.service.js';
import type { PreparedReport } from './reports.service.js';

export interface ReportExportLimits {
  /** Up to this many rows, the CSV is returned by the request itself. */
  readonly syncMaxRows: number;
  /** The most rows any export holds (DOCUMENT 26's worst case is 200,000 movements). */
  readonly maxRows: number;
  /** Ledger rows read per keyset batch. */
  readonly batchSize: number;
}

export const REPORT_EXPORT_LIMITS = Symbol('REPORT_EXPORT_LIMITS');
export const DEFAULT_EXPORT_LIMITS: ReportExportLimits = {
  syncMaxRows: 5_000,
  maxRows: 250_000,
  batchSize: 1_000,
};

/** Where a queued export is handed to be run (BullMQ in production). */
export interface ReportExportQueue {
  enqueue(job: { readonly exportId: string; readonly companyId: string }): Promise<void>;
}
export const REPORT_EXPORT_QUEUE = Symbol('REPORT_EXPORT_QUEUE');

export interface ExportPayload {
  readonly id: string;
  readonly report_key: string;
  readonly status: 'queued' | 'running' | 'completed' | 'failed';
  readonly row_count: number | null;
  readonly failure_reason: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
}

export type ExportOutcome =
  | {
      readonly kind: 'file';
      readonly filename: string;
      readonly body: Buffer;
      readonly rowCount: number;
    }
  | { readonly kind: 'queued'; readonly export: ExportPayload };

/** The filters as stored on a queued export, so the job reruns exactly the request. */
interface StoredFilters {
  readonly filters: ActiveFilters;
  readonly confirm_large_range: boolean;
}

function payload(row: {
  id: string;
  reportKey: string;
  status: ExportPayload['status'];
  rowCount: number | null;
  failureReason: string | null;
  createdAt: Date;
  completedAt: Date | null;
}): ExportPayload {
  return {
    id: row.id,
    report_key: row.reportKey,
    status: row.status,
    row_count: row.rowCount,
    failure_reason: row.failureReason,
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
  };
}

export function exportFilename(key: ReportKey, meta: ReportMeta): string {
  const span =
    meta.range === null ? meta.generated_at.slice(0, 10) : `${meta.range.from}_${meta.range.to}`;
  return `ufuq-${key}-${span}.csv`;
}

/** How many rows the export would hold: the report's own total, one row read. */
async function countRows(prepared: PreparedReport, key: ReportKey): Promise<number> {
  const result = await REPORT_QUERIES[key](prepared.qc, { offset: 0, limit: 1 });
  return result.total;
}

/**
 * The CSV text, in pieces: preamble, header, then the rows — for the ledger
 * in keyset batches, for every other report its full (headcount- or
 * catalogue-bounded) row set.
 */
async function buildCsv(
  prepared: PreparedReport,
  key: ReportKey,
  locale: Locale,
  companyName: string,
  limits: ReportExportLimits,
  run: TenantRun,
): Promise<{ readonly chunks: string[]; readonly rows: number; readonly meta: ReportMeta }> {
  const columns = reportColumns(key, locale);
  const chunks: string[] = [];
  let rows = 0;
  let meta: ReportMeta;
  if (key === 'stock-movements') {
    const ledger: ReportResult = {
      summary: {},
      groups: {},
      trend: [],
      rows: [],
      total: 0,
      provisional: false,
      provisionalReason: null,
      trendUnit: null,
    };
    meta = finishMeta(prepared, ledger);
    chunks.push(csvPreamble(reportPreamble(meta, locale, companyName)), csvHeader(columns));
    for await (const batch of movementBatches(prepared.qc, limits.batchSize, run)) {
      rows += batch.length;
      if (rows > limits.maxRows) {
        throw new AppException(ERROR_CODES.REPORT_EXPORT_TOO_LARGE, 422);
      }
      chunks.push(csvRows(columns, batch));
    }
  } else {
    const result = await REPORT_QUERIES[key](prepared.qc, 'all');
    meta = finishMeta(prepared, result);
    rows = result.rows.length;
    if (rows > limits.maxRows) {
      throw new AppException(ERROR_CODES.REPORT_EXPORT_TOO_LARGE, 422);
    }
    chunks.push(
      csvPreamble(reportPreamble(meta, locale, companyName)),
      csvHeader(columns),
      csvRows(columns, result.rows),
    );
  }
  return { chunks, rows, meta };
}

function toBuffer(chunks: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from(CSV_BOM, 'utf8'),
    ...chunks.map((c) => Buffer.from(c, 'utf8')),
  ]);
}

function auditValues(
  key: ReportKey,
  meta: ReportMeta,
  rows: number,
  mode: 'sync' | 'background',
): Prisma.InputJsonObject {
  return {
    report_key: key,
    format: 'csv',
    mode,
    rows,
    scope: meta.scope as unknown as Prisma.InputJsonObject,
    range: meta.range as unknown as Prisma.InputJsonObject,
    filters: meta.filters as unknown as Prisma.InputJsonObject,
  };
}

@Injectable()
export class ReportExportService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(REPORT_EXPORT_QUEUE) private readonly queue: ReportExportQueue,
    @Inject(REPORT_EXPORT_LIMITS) private readonly limits: ReportExportLimits,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async export(
    ctx: AuthContext,
    key: ReportKey,
    dto: ExportReportDto,
    locale: Locale,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<ExportOutcome> {
    const scope = exportScope(ctx, key);
    const filters = checkFilters(key, dto);
    const confirm = dto.confirm_large_range === true;

    const outcome = await withTenant(this.prisma, ctx.companyId, async (tx) => {
      const prepared = await prepare(
        tx,
        key,
        scope,
        filters,
        { confirm_large_range: confirm },
        now,
      );
      const total = await countRows(prepared, key);
      if (total > this.limits.maxRows) {
        throw new AppException(ERROR_CODES.REPORT_EXPORT_TOO_LARGE, 422);
      }
      if (total <= this.limits.syncMaxRows) {
        const company = await tx.company.findFirstOrThrow({ select: { name: true } });
        const csv = await buildCsv(prepared, key, locale, company.name, this.limits, (fn) =>
          fn(tx),
        );
        return { kind: 'file' as const, csv };
      }
      const stored: StoredFilters = { filters, confirm_large_range: confirm };
      const row = await tx.reportExport.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          requestedBy: ctx.userId,
          reportKey: key,
          format: dto.format,
          filters: stored as unknown as Prisma.InputJsonObject,
          scope: scope as unknown as Prisma.InputJsonObject,
          locale,
        },
      });
      return { kind: 'queued' as const, row };
    });

    if (outcome.kind === 'queued') {
      await this.queue.enqueue({ exportId: outcome.row.id, companyId: ctx.companyId });
      return { kind: 'queued', export: payload(outcome.row) };
    }
    const { csv } = outcome;
    // Post-commit (DOCUMENT 21 §1): only an export that was produced is recorded.
    await this.audit.dispatch([
      {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'REPORT_EXPORTED',
        entityType: 'report_export',
        entityId: generateId(),
        newValues: auditValues(key, csv.meta, csv.rows, 'sync'),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      },
    ]);
    return {
      kind: 'file',
      filename: exportFilename(key, csv.meta),
      body: toBuffer(csv.chunks),
      rowCount: csv.rows,
    };
  }

  /** `GET /reports/exports/{id}` — the requester's own export only (anyone else: 404). */
  async status(ctx: AuthContext, id: string): Promise<ExportPayload> {
    const row = await withTenant(this.prisma, ctx.companyId, (tx) => ownExport(tx, ctx, id));
    return payload(row);
  }

  /** `GET /reports/exports/{id}/download` — the finished file, to its requester. */
  async download(
    ctx: AuthContext,
    id: string,
  ): Promise<{ readonly filename: string; readonly stream: Readable }> {
    const row = await withTenant(this.prisma, ctx.companyId, (tx) => ownExport(tx, ctx, id));
    if (row.status !== 'completed' || row.storageKey === null) {
      throw new AppException(ERROR_CODES.REPORT_EXPORT_NOT_READY, 409);
    }
    return {
      filename: `ufuq-${row.reportKey}-${row.createdAt.toISOString().slice(0, 10)}.csv`,
      stream: await this.storage.get(row.storageKey),
    };
  }
}

async function ownExport(tx: TenantClient, ctx: AuthContext, id: string) {
  const row = await tx.reportExport.findFirst({ where: { id, requestedBy: ctx.userId } });
  if (row === null) throw notFound();
  return row;
}

/**
 * Runs one queued export — the background job's body. Retry-safe: a job that
 * finds its export already completed or failed does nothing; one that finds
 * it `running` (an earlier attempt died) runs it again from the start.
 */
@Injectable()
export class ReportExportRunner {
  private readonly logger = new Logger(ReportExportRunner.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ReportEventPublisher) private readonly events: ReportEventPublisher,
    @Inject(REPORT_EXPORT_LIMITS) private readonly limits: ReportExportLimits,
  ) {}

  async run(exportId: string, companyId: string, now: Date = new Date()): Promise<void> {
    const row = await withTenant(this.prisma, companyId, async (tx) => {
      const found = await tx.reportExport.findFirst({ where: { id: exportId } });
      if (found === null || found.status === 'completed' || found.status === 'failed') {
        return null;
      }
      return tx.reportExport.update({
        where: { id: exportId },
        data: { status: 'running', startedAt: now },
      });
    });
    if (row === null) return;

    const key = row.reportKey as ReportKey;
    try {
      const stored = row.filters as unknown as StoredFilters;
      const scope = row.scope as unknown as ReportScope;
      const setup = await withTenant(this.prisma, companyId, async (tx) => ({
        prepared: await prepare(
          tx,
          key,
          scope,
          stored.filters,
          { confirm_large_range: stored.confirm_large_range },
          now,
        ),
        company: await tx.company.findFirstOrThrow({ select: { name: true } }),
      }));
      const locale = row.locale as Locale;
      const csv =
        key === 'stock-movements'
          ? // The ledger: one short transaction per keyset batch.
            await buildCsv(setup.prepared, key, locale, setup.company.name, this.limits, (fn) =>
              withTenant(this.prisma, companyId, fn),
            )
          : // Every other report is one bounded query set, in one transaction.
            await withTenant(this.prisma, companyId, (tx) =>
              buildCsv(
                { ...setup.prepared, qc: { ...setup.prepared.qc, tx } },
                key,
                locale,
                setup.company.name,
                this.limits,
                (fn) => fn(tx),
              ),
            );
      const body = toBuffer(csv.chunks);
      const storageKey = `report-exports/${companyId}/${exportId}.csv`;
      await this.storage.put({
        key: storageKey,
        body,
        contentType: 'text/csv; charset=utf-8',
        checksum: createHash('sha256').update(body).digest('hex'),
      });
      await withTenant(this.prisma, companyId, (tx) =>
        tx.reportExport.update({
          where: { id: exportId },
          data: {
            status: 'completed',
            rowCount: csv.rows,
            storageKey,
            completedAt: new Date(),
          },
        }),
      );
      await this.audit.dispatch([
        {
          companyId,
          userId: row.requestedBy,
          action: 'REPORT_EXPORTED',
          entityType: 'report_export',
          entityId: exportId,
          newValues: auditValues(key, csv.meta, csv.rows, 'background'),
        },
      ]);
      await this.events.publish([
        {
          type: 'report_export_completed',
          companyId,
          userId: row.requestedBy,
          exportId,
          reportKey: key,
          occurredAt: new Date(),
        },
      ]);
    } catch (error) {
      this.logger.error(
        `Report export ${exportId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const reason =
        error instanceof AppException && error.appErrorCode === ERROR_CODES.REPORT_EXPORT_TOO_LARGE
          ? 'too_large'
          : 'generation_failed';
      await withTenant(this.prisma, companyId, (tx) =>
        tx.reportExport.update({
          where: { id: exportId },
          data: { status: 'failed', failureReason: reason, completedAt: new Date() },
        }),
      );
      await this.events.publish([
        {
          type: 'report_export_failed',
          companyId,
          userId: row.requestedBy,
          exportId,
          reportKey: key,
          occurredAt: new Date(),
        },
      ]);
    }
  }
}

/** Without background workers (tests, a local stack): run the job in this process. */
@Injectable()
export class InProcessReportExportQueue implements ReportExportQueue {
  constructor(@Inject(ReportExportRunner) private readonly runner: ReportExportRunner) {}

  enqueue(job: { readonly exportId: string; readonly companyId: string }): Promise<void> {
    setImmediate(() => {
      void this.runner.run(job.exportId, job.companyId);
    });
    return Promise.resolve();
  }
}
