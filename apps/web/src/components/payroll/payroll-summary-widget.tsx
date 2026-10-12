'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { monthLabel, payrollPath } from '../../lib/payroll';
import type { PayrollPeriod } from '../../lib/payroll';
import { Card } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, Figure, PeriodStatusBadge } from './payroll-shared';

/**
 * DOCUMENT 04 B1 "Payroll summary": the latest payroll period's state, total
 * gross, total deductions and employee count. The figures are the period's
 * own stored totals from `GET /payroll/periods` — nothing is recalculated
 * here. Loads, fails and retries on its own. Rendered only for a company-wide
 * `payroll.view` (ADMIN); a MANAGER never sees it (OD-07 A).
 */
export function PayrollSummaryWidget({
  locale,
  t,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly currency: string;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<PayrollPeriod>('/payroll/periods', { locale, signal, query: { per_page: '1' } }),
    [locale],
  );
  const resource = useResource(load);
  const latest = resource.state.status === 'ready' ? (resource.state.value.items[0] ?? null) : null;

  return (
    <Card
      title={t('payroll.summary_title')}
      className="tasks-reassignment"
      action={
        <Link className="tasks-back" href={payrollPath(locale)}>
          {t('payroll.open_payroll')}
        </Link>
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={2} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' && latest === null ? (
        <p className="tasks-muted">{t('payroll.empty')}</p>
      ) : null}
      {latest === null ? null : (
        <div className="payroll-figures">
          <Figure label={monthLabel(latest.year, latest.month, locale)}>
            <PeriodStatusBadge status={latest.status} t={t} />
          </Figure>
          <Figure label={t('payroll.col_gross')}>
            <Amount value={latest.total_gross} currency={currency} locale={locale} />
          </Figure>
          <Figure label={t('payroll.col_deductions')}>
            <Amount value={latest.total_deductions} currency={currency} locale={locale} />
          </Figure>
          <Figure label={t('payroll.col_employees')}>
            <span dir="ltr">{latest.employee_count}</span>
          </Figure>
        </div>
      )}
    </Card>
  );
}
