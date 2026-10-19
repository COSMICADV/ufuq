'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne, sendRaw } from '../../lib/api-client';
import {
  activeFilterCount,
  defaultFilters,
  exportBody,
  isLargeRange,
  REPORT_CHART,
  REPORT_COLUMNS,
  REPORT_FILTERS,
  REPORT_GROUP_TABLES,
  REPORT_STATUSES,
  REPORT_SUMMARY,
  reportQuery,
  reportsPath,
  widerRange,
} from '../../lib/reports';
import type { FilterField, ReportFilters, ReportKey, ReportPayload } from '../../lib/reports';
import { localName } from '../../lib/warehouse';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, Select } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { ReportMeta, ReportsShell, ReportTable, TrendChart, ValueView } from './report-shared';

const PER_PAGE = 25;

interface Option {
  readonly value: string;
  readonly label: string;
}

interface Context {
  readonly session: SessionView;
  readonly today: string;
  readonly options: Partial<Record<FilterField, readonly Option[]>>;
}

/** The company's calendar day — reports' ranges are company days (DOCUMENT 11 §9). */
function companyToday(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Reference lists a filter needs; one that the caller may not list is simply absent. */
async function loadOptions(
  key: ReportKey,
  locale: Locale,
  signal: AbortSignal,
): Promise<Partial<Record<FilterField, readonly Option[]>>> {
  const fields = REPORT_FILTERS[key];
  const optional = async <T,>(run: () => Promise<readonly T[]>): Promise<readonly T[]> => {
    try {
      return await run();
    } catch {
      return [];
    }
  };
  const options: Partial<Record<FilterField, readonly Option[]>> = {};
  const query = { per_page: '100' };
  await Promise.all([
    fields.includes('department_id')
      ? optional(
          async () =>
            (
              await fetchMany<{ id: string; name_ar: string; name_en: string }>('/departments', {
                locale,
                signal,
                query,
              })
            ).items,
        ).then((items) => {
          options.department_id = items.map((d) => ({ value: d.id, label: localName(d, locale) }));
        })
      : null,
    fields.includes('employee_id')
      ? optional(
          async () =>
            (
              await fetchMany<{
                id: string;
                first_name: string;
                last_name: string;
                employee_code: string;
              }>('/employees', {
                locale,
                signal,
                query,
              })
            ).items,
        ).then((items) => {
          options.employee_id = items.map((e) => ({
            value: e.id,
            label: `${e.first_name} ${e.last_name} (${e.employee_code})`,
          }));
        })
      : null,
    fields.includes('warehouse_id')
      ? optional(
          async () =>
            (
              await fetchMany<{ id: string; name_ar: string; name_en: string }>('/warehouses', {
                locale,
                signal,
                query,
              })
            ).items,
        ).then((items) => {
          options.warehouse_id = items.map((w) => ({ value: w.id, label: localName(w, locale) }));
        })
      : null,
    fields.includes('category_id')
      ? optional(
          async () =>
            (
              await fetchMany<{ id: string; name_ar: string; name_en: string }>(
                '/product-categories',
                { locale, signal, query },
              )
            ).items,
        ).then((items) => {
          options.category_id = items.map((c) => ({ value: c.id, label: localName(c, locale) }));
        })
      : null,
    fields.includes('product_id')
      ? optional(
          async () =>
            (
              await fetchMany<{ id: string; sku: string; name_ar: string; name_en: string }>(
                '/products',
                { locale, signal, query },
              )
            ).items,
        ).then((items) => {
          options.product_id = items.map((p) => ({
            value: p.id,
            label: `${localName(p, locale)} (${p.sku})`,
          }));
        })
      : null,
  ]);
  return options;
}

/** The options a field always has, from the catalogue of values. */
function enumOptions(key: ReportKey, field: FilterField, t: Translator): readonly Option[] | null {
  switch (field) {
    case 'status': {
      const statuses = REPORT_STATUSES[key];
      return statuses === null
        ? null
        : statuses.values.map((value) => ({ value, label: t(`${statuses.labelPrefix}${value}`) }));
    }
    case 'work_mode':
      return ['office', 'wfh'].map((value) => ({ value, label: t(`attendance.mode.${value}`) }));
    case 'priority':
      return ['low', 'medium', 'high', 'urgent'].map((value) => ({
        value,
        label: t(`tasks.priority.${value}`),
      }));
    case 'goal_type':
      return ['sales', 'task', 'custom'].map((value) => ({
        value,
        label: t(`goals.type.${value}`),
      }));
    case 'product_status':
      return ['active', 'discontinued'].map((value) => ({
        value,
        label: t(`inventory.status.${value}`),
      }));
    case 'movement_type':
      return [
        'purchase',
        'sale',
        'transfer_in',
        'transfer_out',
        'adjustment',
        'return',
        'damage',
        'manual_addition',
        'manual_removal',
      ].map((value) => ({ value, label: t(`warehouse.movement.${value}`) }));
    default:
      return null;
  }
}

function FilterFields({
  reportKey,
  value,
  options,
  t,
  onChange,
}: {
  readonly reportKey: ReportKey;
  readonly value: ReportFilters;
  readonly options: Partial<Record<FilterField, readonly Option[]>>;
  readonly t: Translator;
  readonly onChange: (patch: ReportFilters) => void;
}): React.JSX.Element {
  return (
    <>
      {REPORT_FILTERS[reportKey].map((field) => {
        const label = t(`reports.filter.${field}`);
        if (field === 'from' || field === 'to') {
          return (
            <Field key={field} label={label}>
              <Input
                type="date"
                value={value[field] ?? ''}
                onChange={(event) => {
                  onChange({ [field]: event.target.value });
                }}
              />
            </Field>
          );
        }
        const list = enumOptions(reportKey, field, t) ?? options[field] ?? null;
        if (field === 'user_id' && list === null) return null;
        return (
          <Field key={field} label={label}>
            <Select
              value={value[field] ?? ''}
              onChange={(event) => {
                onChange({ [field]: event.target.value });
              }}
            >
              <option value="">{t('reports.filter.any')}</option>
              {(list ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
        );
      })}
    </>
  );
}

type ExportState =
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'queued'; readonly id: string }
  | { readonly status: 'ready'; readonly id: string; readonly rows: number }
  | { readonly status: 'failed' };

/** Hand a file to the reader: the share sheet on a touch device, a download otherwise. */
async function deliver(blob: Blob, filename: string): Promise<void> {
  const file =
    typeof File === 'undefined' ? null : new File([blob], filename, { type: 'text/csv' });
  const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  if (
    coarse &&
    file !== null &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch {
      // A dismissed share sheet falls back to a plain download.
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filenameOf(response: Response, fallback: string): string {
  const header = response.headers.get('Content-Disposition') ?? '';
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

/**
 * `/admin/reports/:reportKey` — DOCUMENT 04 B18. Filter bar (date range,
 * department, employee, the report's own filters), applied explicitly — the
 * report endpoints allow 20 requests an hour, so typing never spends one.
 * Results: what the report is (scope, range, filters, provisional), the
 * headline figures, a trend chart, the breakdowns and the paged detail
 * table. Export (CSV) and print. Filters are kept on any error.
 */
export function ReportViewer({
  locale,
  reportKey,
}: {
  readonly locale: Locale;
  readonly reportKey: ReportKey;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const loadContext = useCallback(
    async (signal: AbortSignal): Promise<Context> => {
      const [session, options] = await Promise.all([
        loadSession(locale, signal),
        loadOptions(reportKey, locale, signal),
      ]);
      return { session, options, today: companyToday(session.timeZone) };
    },
    [locale, reportKey],
  );
  const context = useResource(loadContext);
  const title = t(`reports.key.${reportKey}.title`);
  const back = { href: reportsPath(locale), label: t('reports.back_to_catalogue') };

  return (
    <ReportsShell title={title} description={t(`reports.key.${reportKey}.description`)} back={back}>
      {context.state.status === 'loading' ? (
        <LoadingState t={t} rows={8} />
      ) : context.state.status === 'error' ? (
        <ErrorState error={context.state.error} t={t} onRetry={context.reload} />
      ) : (
        <ViewerBody
          locale={locale}
          t={t}
          reportKey={reportKey}
          context={context.state.value}
          title={title}
        />
      )}
    </ReportsShell>
  );
}

function ViewerBody({
  locale,
  t,
  reportKey,
  context,
  title,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly reportKey: ReportKey;
  readonly context: Context;
  readonly title: string;
}): React.JSX.Element {
  const { session, today, options } = context;
  const [draft, setDraft] = useState<ReportFilters>(() => defaultFilters(reportKey, today));
  const [applied, setApplied] = useState<{ filters: ReportFilters; confirm: boolean }>(() => ({
    filters: defaultFilters(reportKey, today),
    confirm: false,
  }));
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState<ReportFilters | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportState>({ status: 'idle' });

  const load = useCallback(
    (signal: AbortSignal) =>
      fetchOne<ReportPayload>(`/reports/${reportKey}`, {
        locale,
        signal,
        query: reportQuery(reportKey, applied.filters, page, PER_PAGE, applied.confirm),
      }),
    [locale, reportKey, applied, page],
  );
  const result = useResource(load);

  const apply = (filters: ReportFilters): void => {
    if (isLargeRange(filters.from, filters.to)) {
      setConfirming(filters);
      return;
    }
    setApplied({ filters, confirm: false });
    setPage(1);
    setExporting({ status: 'idle' });
  };

  // A queued export is polled until it is ready (the status endpoint is not a
  // report run and does not spend the hourly allowance).
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (exporting.status !== 'queued') return undefined;
    let attempts = 0;
    const tick = async (): Promise<void> => {
      attempts += 1;
      try {
        const status = await fetchOne<{ status: string; row_count: number | null }>(
          `/reports/exports/${exporting.id}`,
          { locale },
        );
        if (status.status === 'completed') {
          setExporting({ status: 'ready', id: exporting.id, rows: status.row_count ?? 0 });
          return;
        }
        if (status.status === 'failed' || attempts > 60) {
          setExporting({ status: 'failed' });
          return;
        }
      } catch {
        setExporting({ status: 'failed' });
        return;
      }
      pollTimer.current = setTimeout(() => void tick(), 3000);
    };
    pollTimer.current = setTimeout(() => void tick(), 1500);
    return () => {
      if (pollTimer.current !== null) clearTimeout(pollTimer.current);
    };
  }, [exporting, locale]);

  const startExport = async (): Promise<void> => {
    setExporting({ status: 'running' });
    try {
      const response = await sendRaw(`/reports/${reportKey}/export`, {
        locale,
        method: 'POST',
        body: exportBody(reportKey, applied.filters, applied.confirm),
      });
      if (response.status === 202) {
        const body = (await response.json()) as { data: { id: string } };
        setExporting({ status: 'queued', id: body.data.id });
        return;
      }
      await deliver(await response.blob(), filenameOf(response, `ufuq-${reportKey}.csv`));
      setExporting({ status: 'idle' });
    } catch {
      setExporting({ status: 'failed' });
    }
  };

  const download = async (id: string): Promise<void> => {
    try {
      const response = await sendRaw(`/reports/exports/${id}/download`, { locale });
      await deliver(await response.blob(), filenameOf(response, `ufuq-${reportKey}.csv`));
    } catch {
      setExporting({ status: 'failed' });
    }
  };

  const count = activeFilterCount(reportKey, applied.filters, today);
  const filterValue = (field: string, value: string): string => {
    const named =
      result.state.status === 'ready' ? result.state.value.report.filter_labels[field] : undefined;
    if (named !== undefined) return named[locale];
    const fromList = (
      enumOptions(reportKey, field as FilterField, t) ??
      options[field as FilterField] ??
      []
    ).find((option) => option.value === value);
    return fromList?.label ?? value;
  };
  const allOptions: Partial<Record<FilterField, readonly Option[]>> = {
    ...options,
    ...(result.state.status === 'ready' && result.state.value.groups.by_user !== undefined
      ? {
          user_id: result.state.value.groups.by_user.map((row) => ({
            value: String(row.user_id),
            label: String(row.email ?? row.user_id),
          })),
        }
      : {}),
  };

  return (
    <>
      <section className="filter-bar report-no-print" aria-label={t('reports.filter.title')}>
        <div className="filter-bar__inline">
          <FilterFields
            reportKey={reportKey}
            value={draft}
            options={allOptions}
            t={t}
            onChange={(patch) => {
              setDraft({ ...draft, ...patch });
            }}
          />
        </div>
        <div className="filter-bar__toggle">
          <Button
            variant="secondary"
            onClick={() => {
              setSheetOpen(true);
            }}
          >
            {count > 0
              ? `${t('reports.filter.open')} (${String(count)})`
              : t('reports.filter.open')}
          </Button>
        </div>
        <div className="report-filter-actions">
          <Button
            onClick={() => {
              apply(draft);
            }}
          >
            {t('reports.filter.apply')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const reset = defaultFilters(reportKey, today);
              setDraft(reset);
              apply(reset);
            }}
          >
            {t('reports.filter.reset')}
          </Button>
        </div>
      </section>

      <div className="report-toolbar report-no-print">
        <Button
          variant="secondary"
          loading={exporting.status === 'running'}
          disabled={result.state.status !== 'ready' || result.state.value.pagination.total === 0}
          onClick={() => void startExport()}
        >
          {t('reports.action.export_csv')}
        </Button>
        <Button
          variant="ghost"
          disabled={result.state.status !== 'ready'}
          onClick={() => {
            window.print();
          }}
        >
          {t('reports.action.print')}
        </Button>
      </div>

      {exporting.status === 'queued' ? (
        <Alert tone="info" title={t('reports.state.export_queued_title')}>
          {t('reports.state.export_queued_body')}
        </Alert>
      ) : exporting.status === 'ready' ? (
        <Alert tone="success" title={t('reports.state.export_ready_title')}>
          {t('reports.state.export_ready_body', { count: String(exporting.rows) })}{' '}
          <Button variant="secondary" size="sm" onClick={() => void download(exporting.id)}>
            {t('reports.action.download')}
          </Button>
        </Alert>
      ) : exporting.status === 'failed' ? (
        <Alert tone="danger" title={t('reports.state.export_failed_title')}>
          {t('reports.state.export_failed_body')}{' '}
          <Button variant="secondary" size="sm" onClick={() => void startExport()}>
            {t('reports.action.retry')}
          </Button>
        </Alert>
      ) : null}

      {result.state.status === 'loading' ? (
        <LoadingState t={t} rows={8} />
      ) : result.state.status === 'error' ? (
        result.state.error.status === 429 ? (
          <Alert tone="warning" title={t('state.error')}>
            {t('reports.state.rate_limited')}
          </Alert>
        ) : result.state.error.status === 403 ? (
          // A refusal is final for this caller: no "try again" (DOCUMENT 11 §11).
          <Alert tone="danger" title={t('state.action_blocked')}>
            {t('error.forbidden')}
          </Alert>
        ) : result.state.error.code === 'REPORT_RANGE_CONFIRMATION_REQUIRED' ? (
          <Alert tone="warning" title={t('reports.state.large_range_title')}>
            {t('reports.state.large_range_body')}
          </Alert>
        ) : (
          <ErrorState error={result.state.error} t={t} onRetry={result.reload} />
        )
      ) : (
        <ReportResultView
          locale={locale}
          t={t}
          reportKey={reportKey}
          payload={result.state.value}
          session={session}
          title={title}
          filterValue={filterValue}
          onPage={setPage}
          onWiden={
            REPORT_FILTERS[reportKey].includes('from')
              ? () => {
                  const wider = { ...applied.filters, ...widerRange(today) };
                  setDraft(wider);
                  apply(wider);
                }
              : null
          }
        />
      )}

      <Modal
        open={sheetOpen}
        title={t('reports.filter.title')}
        closeLabel={t('action.close')}
        onClose={() => {
          setSheetOpen(false);
        }}
        footer={
          <div className="settings-form__actions">
            <Button
              onClick={() => {
                setSheetOpen(false);
                apply(draft);
              }}
            >
              {t('reports.filter.apply')}
            </Button>
          </div>
        }
      >
        <div className="report-sheet-fields">
          <FilterFields
            reportKey={reportKey}
            value={draft}
            options={allOptions}
            t={t}
            onChange={(patch) => {
              setDraft({ ...draft, ...patch });
            }}
          />
        </div>
      </Modal>

      <Modal
        open={confirming !== null}
        title={t('reports.state.large_range_title')}
        closeLabel={t('action.cancel')}
        onClose={() => {
          setConfirming(null);
        }}
        footer={
          <div className="settings-form__actions">
            <Button
              onClick={() => {
                if (confirming !== null) {
                  setApplied({ filters: confirming, confirm: true });
                  setPage(1);
                }
                setConfirming(null);
              }}
            >
              {t('reports.state.large_range_confirm')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(null);
              }}
            >
              {t('action.cancel')}
            </Button>
          </div>
        }
      >
        <p>{t('reports.state.large_range_body')}</p>
      </Modal>
    </>
  );
}

function ReportResultView({
  locale,
  t,
  reportKey,
  payload,
  session,
  title,
  filterValue,
  onPage,
  onWiden,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly reportKey: ReportKey;
  readonly payload: ReportPayload;
  readonly session: SessionView;
  readonly title: string;
  readonly filterValue: (field: string, value: string) => string;
  readonly onPage: (page: number) => void;
  readonly onWiden: (() => void) | null;
}): React.JSX.Element {
  const shared = { locale, t, currency: session.currency, timeZone: session.timeZone };
  const chartSeries = REPORT_CHART[reportKey];
  const { page, total_pages: pages, total } = payload.pagination;
  return (
    <>
      <ReportMeta
        report={payload.report}
        locale={locale}
        title={title}
        companyLabel={session.companyName}
        filterValue={filterValue}
      />
      {total === 0 ? (
        <EmptyState
          title={t('reports.state.no_data_title')}
          description={t('reports.state.no_data_body')}
          action={
            onWiden === null ? null : (
              <Button variant="secondary" onClick={onWiden}>
                {t('reports.state.widen_range')}
              </Button>
            )
          }
        />
      ) : (
        <>
          <section className="report-summary" aria-label={t('reports.section.summary')}>
            {REPORT_SUMMARY[reportKey].map((column) => (
              <Card key={column.field} className="kpi report-kpi">
                <span className="kpi__label">{t(`reports.column.${column.label}`)}</span>
                <strong className="kpi__value">
                  <ValueView row={payload.summary} column={column} {...shared} />
                </strong>
              </Card>
            ))}
          </section>
          {chartSeries !== null && payload.trend.length > 1 ? (
            <Card title={t('reports.section.trend')} className="report-section">
              <TrendChart
                points={payload.trend}
                series={chartSeries}
                label={t(`reports.column.${chartSeries}`)}
                t={t}
              />
            </Card>
          ) : null}
          {REPORT_GROUP_TABLES[reportKey].map((group) => {
            const rows = payload.groups[group.name] ?? [];
            return rows.length === 0 ? null : (
              <Card
                key={group.name}
                title={t(`reports.section.${group.name}`)}
                className="report-section"
              >
                <ReportTable
                  columns={group.columns}
                  rows={rows}
                  caption={t(`reports.section.${group.name}`)}
                  {...shared}
                />
              </Card>
            );
          })}
          <Card title={t('reports.section.rows')} className="report-section">
            <ReportTable
              columns={REPORT_COLUMNS[reportKey]}
              rows={payload.rows}
              caption={t('reports.section.rows')}
              {...shared}
            />
            <nav className="report-pages" aria-label={t('reports.section.rows')}>
              <Button
                variant="ghost"
                size="sm"
                className="report-no-print"
                disabled={page <= 1}
                onClick={() => {
                  onPage(page - 1);
                }}
              >
                {t('reports.table.previous')}
              </Button>
              <span>
                {t('reports.table.page', {
                  page: String(page),
                  pages: String(pages),
                  total: String(total),
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="report-no-print"
                disabled={page >= pages}
                onClick={() => {
                  onPage(page + 1);
                }}
              >
                {t('reports.table.next')}
              </Button>
            </nav>
          </Card>
        </>
      )}
    </>
  );
}
