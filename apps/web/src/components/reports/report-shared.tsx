'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { localizedCell, chartMagnitude } from '../../lib/reports';
import type { Cell, Column, ReportPayload, ReportRow } from '../../lib/reports';
import { quantityLabel } from '../../lib/warehouse';
import { Badge } from '../design-system';
import { Amount } from '../warehouse/warehouse-shared';

/**
 * The pieces every report screen shares — DOCUMENT 04 B17/B18/C13,
 * DOCUMENT 18 rules 4–7. Functional layout on the current design system; the
 * visual redesign comes later.
 */

export function ReportsShell({
  title,
  description,
  back,
  actions,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly back?: { readonly href: string; readonly label: string };
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="tasks-page report-page">
      <header className="page-heading">
        <div>
          {back === undefined ? null : (
            <Link className="tasks-back report-no-print" href={back.href}>
              {back.label}
            </Link>
          )}
          <h1>{title}</h1>
          {description === undefined ? null : <p>{description}</p>}
        </div>
        {actions === undefined ? null : (
          <div className="report-actions report-no-print">{actions}</div>
        )}
      </header>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}

/** Generation time in the company's zone — the clock the report was produced against. */
export function formatInstant(instant: string, locale: Locale, timeZone: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    numberingSystem: 'latn',
  }).format(new Date(instant));
}

/** One value, shown by its column's kind. Decimals stay the API's strings. */
export function ValueView({
  row,
  column,
  locale,
  t,
  currency,
  timeZone,
}: {
  readonly row: ReportRow | Readonly<Record<string, Cell>>;
  readonly column: Column;
  readonly locale: Locale;
  readonly t: Translator;
  readonly currency: string;
  readonly timeZone: string;
}): React.JSX.Element {
  const kind = column.kind;
  const value: Cell =
    typeof kind === 'object' && 'localized' in kind
      ? localizedCell(row, kind.localized, locale)
      : (row[column.field] ?? null);
  if (value === null || value === '') {
    return <span className="report-none">{t('reports.value.none')}</span>;
  }
  if (typeof kind === 'object' && 'enumPrefix' in kind) {
    return <span>{t(`${kind.enumPrefix}${String(value)}`)}</span>;
  }
  if (typeof kind === 'object' && 'localized' in kind) {
    return <span dir="auto">{String(value)}</span>;
  }
  switch (kind) {
    case 'money':
      return <Amount value={String(value)} currency={currency} locale={locale} />;
    case 'quantity':
      return <span dir="ltr">{quantityLabel(String(value))}</span>;
    case 'percent':
      return <span dir="ltr">{`${String(value)}%`}</span>;
    case 'count':
      return <span dir="ltr">{String(value)}</span>;
    case 'date':
      return <span dir="ltr">{String(value)}</span>;
    case 'datetime':
      return <span dir="ltr">{formatInstant(String(value), locale, timeZone)}</span>;
    case 'bool':
      return <span>{value === true ? t('reports.value.yes') : t('reports.value.no')}</span>;
    case 'text':
      return <span dir="auto">{String(value)}</span>;
  }
}

/**
 * What the report is — DOCUMENT 18 rules 4 and 7: scope (a manager's team
 * report says so), range, every filter with its name, when and in which zone
 * it was produced, and whether it is provisional. Printed with the report.
 */
export function ReportMeta({
  report,
  locale,
  title,
  companyLabel,
  filterValue,
}: {
  readonly report: ReportPayload['report'];
  readonly locale: Locale;
  readonly title: string;
  readonly companyLabel: string | null;
  readonly filterValue: (field: string, value: string) => string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const filters = Object.entries(report.filters);
  return (
    <section className="report-meta" aria-label={t('reports.meta.report')}>
      <p className="report-meta__print-title report-print-only">
        <strong>{title}</strong>
        {companyLabel === null ? null : <span> · {companyLabel}</span>}
      </p>
      <dl className="report-meta__facts">
        <div>
          <dt>{t('reports.meta.scope')}</dt>
          <dd>
            {report.scope.type === 'company' ? (
              t('reports.meta.scope_company')
            ) : (
              <Badge tone="warning">{t('reports.meta.scope_team')}</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('reports.meta.range')}</dt>
          <dd dir={report.range === null ? 'auto' : 'ltr'}>
            {report.range === null
              ? t('reports.meta.range_none')
              : `${report.range.from} → ${report.range.to}`}
          </dd>
        </div>
        <div>
          <dt>{t('reports.meta.filters')}</dt>
          <dd>
            {filters.length === 0
              ? t('reports.meta.no_filters')
              : filters
                  .map(
                    ([field, value]) =>
                      `${t(`reports.filter.${field}`)}: ${filterValue(field, value)}`,
                  )
                  .join(' · ')}
          </dd>
        </div>
        <div>
          <dt>{t('reports.meta.generated_at')}</dt>
          <dd>
            {formatInstant(report.generated_at, locale, report.timezone)}{' '}
            <span className="tasks-muted" dir="ltr">
              ({report.timezone})
            </span>
          </dd>
        </div>
        {report.provisional ? (
          <div>
            <dt>{t('reports.meta.provisional')}</dt>
            <dd>
              <Badge tone="warning">{t('reports.provisional_badge')}</Badge>{' '}
              {t(`reports.provisional_reason.${report.provisional_reason ?? 'period_not_ended'}`)}
            </dd>
          </div>
        ) : null}
      </dl>
      {report.scope.type === 'team' ? (
        <p className="report-meta__note">{t('reports.meta.scope_team_note')}</p>
      ) : null}
    </section>
  );
}

/**
 * A bar per period. Bars are drawn from the values for their height only; the
 * figures shown are the API's own strings. A table of the same figures sits
 * behind it for screen readers and print.
 */
export function TrendChart({
  points,
  series,
  label,
  t,
}: {
  readonly points: ReportPayload['trend'];
  readonly series: string;
  readonly label: string;
  readonly t: Translator;
}): React.JSX.Element | null {
  if (points.length === 0) return null;
  const magnitudes = points.map((point) =>
    Math.max(0, chartMagnitude(point.values[series] ?? null)),
  );
  const max = Math.max(1, ...magnitudes);
  return (
    <figure className="report-chart">
      <figcaption>{label}</figcaption>
      <ol
        className="report-chart__bars"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${String(points.length)}, minmax(0, 1fr))` }}
      >
        {points.map((point, index) => (
          <li key={point.period} title={`${point.period}: ${String(point.values[series] ?? '')}`}>
            <span
              className="report-chart__bar"
              style={{
                blockSize: `${String(Math.floor(((magnitudes[index] ?? 0) * 100) / max))}%`,
              }}
            />
          </li>
        ))}
      </ol>
      <div className="report-chart__axis" aria-hidden="true" dir="ltr">
        <span>{points[0]?.period}</span>
        <span>{points.at(-1)?.period}</span>
      </div>
      <table className="visually-hidden">
        <caption>{label}</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.period}>
              <th scope="row">{point.period}</th>
              <td>{String(point.values[series] ?? t('reports.value.none'))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * A report table: on every width it stays a table and scrolls sideways inside
 * its own box, the first column frozen (DOCUMENT 18 "Mobile behaviour",
 * DOCUMENT 04 B18) — the page itself never scrolls sideways.
 */
export function ReportTable({
  columns,
  rows,
  locale,
  t,
  currency,
  timeZone,
  caption,
}: {
  readonly columns: readonly Column[];
  readonly rows: readonly ReportRow[];
  readonly locale: Locale;
  readonly t: Translator;
  readonly currency: string;
  readonly timeZone: string;
  readonly caption: string;
}): React.JSX.Element {
  return (
    <div className="report-table" role="region" aria-label={caption} tabIndex={0}>
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.field} scope="col">
                {t(`reports.column.${column.label}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column, cellIndex) =>
                cellIndex === 0 ? (
                  <th key={column.field} scope="row">
                    <ValueView
                      row={row}
                      column={column}
                      locale={locale}
                      t={t}
                      currency={currency}
                      timeZone={timeZone}
                    />
                  </th>
                ) : (
                  <td key={column.field}>
                    <ValueView
                      row={row}
                      column={column}
                      locale={locale}
                      t={t}
                      currency={currency}
                      timeZone={timeZone}
                    />
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
