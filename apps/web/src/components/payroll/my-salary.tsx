'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import { monthLabel, salaryPath } from '../../lib/payroll';
import type { PayrollEstimate, PayrollLine } from '../../lib/payroll';
import { Alert, Card, EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { Amount, Figure, ProvisionalBadge } from './payroll-shared';

/**
 * The employee's current month — DOCUMENT 15 "EMPLOYEE SALARY VIEW",
 * DOCUMENT 04 C1 component 5. Monthly salary, the estimated salary, daily wage,
 * working days and days worked. **Provisional until the period is finalized**
 * (rule 10), and labelled so before anything else, because on a phone this is
 * where a figure is most easily misread as final.
 *
 * It loads, fails and retries on its own, like the other dashboard cards. A
 * caller without self salary access never reaches the API call: the card is
 * not rendered for them (and the API refuses it anyway).
 */
export function SalaryEstimateCard({
  locale,
  t,
  linkToSalary,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly linkToSalary: boolean;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<PayrollEstimate>('/payroll/me', { locale, signal }),
    [locale],
  );
  const resource = useResource(load);

  return (
    <Card
      title={t('salary.current_title')}
      className="tasks-reassignment"
      action={
        linkToSalary ? (
          <Link className="tasks-back" href={salaryPath(locale)}>
            {t('salary.open')}
          </Link>
        ) : (
          <ProvisionalBadge t={t} />
        )
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        <Estimate locale={locale} t={t} estimate={resource.state.value} />
      ) : null}
    </Card>
  );
}

function Estimate({
  locale,
  t,
  estimate,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly estimate: PayrollEstimate;
}): React.JSX.Element {
  if (!estimate.available) {
    return (
      <p className="tasks-muted">
        {t(`salary.unavailable.${estimate.unavailable_reason ?? 'other'}`)}
      </p>
    );
  }
  const currency = estimate.currency ?? '';
  return (
    <>
      <Alert tone="warning" title={t('salary.provisional_title')}>
        {t('salary.provisional_detail')}
      </Alert>
      <div className="payroll-figures">
        <Figure label={t('salary.monthly_salary')}>
          <Amount value={estimate.monthly_salary ?? '0.00'} currency={currency} locale={locale} />
        </Figure>
        <Figure label={t('salary.estimated_salary')}>
          <Amount value={estimate.estimated_net ?? '0.00'} currency={currency} locale={locale} />
        </Figure>
        <Figure label={t('payroll.daily_wage')}>
          <Amount value={estimate.daily_wage ?? '0.00'} currency={currency} locale={locale} />
        </Figure>
        <Figure label={t('payroll.working_days')}>
          <span dir="ltr">{estimate.working_days ?? 0}</span>
        </Figure>
        <Figure label={t('salary.days_worked')}>
          <span dir="ltr">{estimate.days_worked ?? 0}</span>
        </Figure>
      </div>
    </>
  );
}

/** `/app/salary` — the estimate, then the latest finalized payslips. */
export function MySalary({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="dashboard-widgets">
      <SalaryEstimateCard locale={locale} t={t} linkToSalary={false} />
      <MyPayslips locale={locale} limit={3} />
    </div>
  );
}

/** `/app/salary/history` — the employee's own finalized payslips, newest first. */
export function MyPayslips({
  locale,
  limit,
}: {
  readonly locale: Locale;
  readonly limit?: number;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, history] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<PayrollLine>('/payroll/me/history', {
          locale,
          signal,
          query: { per_page: String(limit ?? 100) },
        }),
      ]);
      return { session, lines: history.items, total: history.meta.total };
    },
    [locale, limit],
  );
  const resource = useResource(load);

  return (
    <Card
      title={t('salary.history_title')}
      className="tasks-reassignment"
      action={
        limit === undefined ? null : (
          <Link className="tasks-back" href={salaryPath(locale, 'history')}>
            {t('salary.history_all')}
          </Link>
        )
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        resource.state.value.lines.length === 0 ? (
          <EmptyState
            title={t('salary.history_empty_title')}
            description={t('salary.history_empty')}
            action={null}
          />
        ) : (
          <ul className="payroll-payslips">
            {resource.state.value.lines.map((line) => (
              <PayslipRow
                key={line.id}
                locale={locale}
                t={t}
                line={line}
                currency={
                  resource.state.status === 'ready' ? resource.state.value.session.currency : ''
                }
              />
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

function PayslipRow({
  locale,
  line,
  currency,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly line: PayrollLine;
  readonly currency: string;
}): React.JSX.Element {
  return (
    <li>
      <Link href={salaryPath(locale, line.period_id)}>
        {monthLabel(line.period_year, line.period_month, locale)}
      </Link>
      <Amount value={line.adjusted_net} currency={currency} locale={locale} />
    </li>
  );
}
