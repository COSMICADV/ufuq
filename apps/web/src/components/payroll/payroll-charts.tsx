'use client';

/**
 * Salary charts — the company's payroll month by month (admin payroll page)
 * and an employee's own net salary month by month (their salary page). The
 * amounts are drawn from the API's decimal strings; every figure a person
 * reads is formatted by `money()` from the same strings, never recomputed.
 */

import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { money, monthLabel } from '../../lib/payroll';
import type { PayrollLine, PayrollPeriod } from '../../lib/payroll';
import { BarList, StackedColumns } from '../dashboard/charts';
import { Card } from '../design-system';
import { loadSession } from '../employees/use-session';
import { useResource } from '../settings/use-resource';

/** A decimal string as a bar length — drawing only, never shown or summed into money. */
function size(amount: string): number {
  const value = Number(amount);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

function compact(locale: Locale, currency: string): (value: number) => string {
  const format = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  return (value) =>
    value === 0 ? '0' : `${format.format(value)}${currency ? ` ${currency}` : ''}`;
}

/** The company's payroll, period by period (oldest first, last 12), and the latest period's make-up. */
export function PayrollCharts({
  locale,
  t,
  periods,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly periods: readonly PayrollPeriod[];
  readonly currency: string;
}): React.JSX.Element | null {
  if (periods.length === 0) return null;
  const ordered = [...periods]
    .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month))
    .slice(-12);
  const latest = ordered[ordered.length - 1] as PayrollPeriod;
  const title = t('insights.payroll_by_month');
  const breakdown = [
    {
      key: 'gross',
      label: t('payroll.col_gross'),
      amount: latest.total_gross,
      color: 'var(--chart-2)',
    },
    {
      key: 'adjustment',
      label: t('insights.attendance_adjustment'),
      amount: latest.total_attendance_adjustment,
      color: 'var(--semantic-warning)',
    },
    {
      key: 'deductions',
      label: t('payroll.col_deductions'),
      amount: latest.total_deductions,
      color: 'var(--semantic-error)',
    },
    {
      key: 'bonuses',
      label: t('payroll.col_bonuses'),
      amount: latest.total_bonuses,
      color: 'var(--chart-3)',
    },
    {
      key: 'net',
      label: t('payroll.col_net'),
      amount: latest.total_net,
      color: 'var(--semantic-success)',
    },
  ];

  return (
    <section className="insights insights--section" aria-label={t('insights.section_payroll')}>
      <header className="insights__header">
        <div>
          <h2>{t('insights.section_payroll')}</h2>
          <p>{t('insights.payroll_description')}</p>
        </div>
      </header>
      <div className="insights__grid">
        <Card title={title} className="insights__wide">
          <StackedColumns
            series={[{ key: 'net', label: t('payroll.col_net'), color: 'var(--chart-1)' }]}
            caption={title}
            format={compact(locale, currency)}
            emptyText={t('insights.empty')}
            columns={ordered.map((period) => ({
              key: period.id,
              label: monthLabel(period.year, period.month, locale),
              title: monthLabel(period.year, period.month, locale),
              values: { net: size(period.total_net) },
              notes: [
                {
                  label: t('payroll.col_gross'),
                  value: money(period.total_gross, currency, locale),
                },
                {
                  label: t('payroll.col_deductions'),
                  value: money(period.total_deductions, currency, locale),
                },
                {
                  label: t('payroll.col_bonuses'),
                  value: money(period.total_bonuses, currency, locale),
                },
                { label: t('payroll.col_employees'), value: String(period.employee_count) },
              ],
            }))}
          />
        </Card>
        <Card
          title={t('insights.payroll_breakdown', {
            month: monthLabel(latest.year, latest.month, locale),
          })}
        >
          <BarList
            caption={t('insights.payroll_breakdown', {
              month: monthLabel(latest.year, latest.month, locale),
            })}
            bars={breakdown.map((row) => ({
              key: row.key,
              label: row.label,
              value: size(row.amount),
              display: money(row.amount, currency, locale),
              color: row.color,
            }))}
          />
        </Card>
      </div>
    </section>
  );
}

/** The employee's own finalized net salary, month by month, with the days behind each. */
export function MySalaryChart({ locale }: { readonly locale: Locale }): React.JSX.Element | null {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, history] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<PayrollLine>('/payroll/me/history', {
          locale,
          signal,
          query: { per_page: '12' },
        }),
      ]);
      return { currency: session.currency, lines: history.items };
    },
    [locale],
  );
  const resource = useResource(load);
  if (resource.state.status !== 'ready' || resource.state.value.lines.length === 0) return null;
  const { currency, lines } = resource.state.value;
  const ordered = [...lines].sort(
    (a, b) => a.period_year * 12 + a.period_month - (b.period_year * 12 + b.period_month),
  );
  const title = t('insights.my_salary_by_month');
  return (
    <Card title={title}>
      <StackedColumns
        series={[{ key: 'net', label: t('payroll.col_net'), color: 'var(--chart-1)' }]}
        caption={title}
        format={compact(locale, currency)}
        emptyText={t('insights.empty')}
        columns={ordered.map((line) => ({
          key: line.id,
          label: monthLabel(line.period_year, line.period_month, locale),
          title: monthLabel(line.period_year, line.period_month, locale),
          values: { net: size(line.adjusted_net) },
          notes: [
            { label: t('payroll.col_net'), value: money(line.adjusted_net, currency, locale) },
            {
              label: t('payroll.col_deductions'),
              value: money(line.total_deductions, currency, locale),
            },
            { label: t('attendance.status.present'), value: String(line.present_days) },
            { label: t('attendance.status.absent'), value: String(line.absent_days) },
          ],
        }))}
      />
    </Card>
  );
}
