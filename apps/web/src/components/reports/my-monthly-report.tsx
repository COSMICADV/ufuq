'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { myMonthlyPath, previousMonth } from '../../lib/reports';
import { Alert } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { MonthlyReportView } from './monthly-report';
import { ReportsShell } from './report-shared';

/**
 * `/app/reports/:month` — DOCUMENT 04 C13: the employee's own report. The
 * employee id is the caller's own (from the session); the API would refuse
 * any other. Mobile first — this is where employees read it (DOCUMENT 18).
 */
export function MyMonthlyReport({
  locale,
  month,
}: {
  readonly locale: Locale;
  readonly month: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  return (
    <ReportsShell title={t('reports.monthly.my_title')}>
      {session.state.status === 'loading' ? (
        <LoadingState t={t} rows={6} />
      ) : session.state.status === 'error' ? (
        <ErrorState error={session.state.error} t={t} onRetry={session.reload} />
      ) : session.state.value.employeeId === null ? (
        <Alert tone="info" title={t('reports.monthly.my_title')}>
          {t('reports.monthly.list_empty')}
        </Alert>
      ) : (
        <MonthlyReportView
          locale={locale}
          employeeId={session.state.value.employeeId}
          month={month}
          monthHref={(m) => myMonthlyPath(locale, m)}
        />
      )}
    </ReportsShell>
  );
}

/** `/app/reports` — opens last month's report, in the company's calendar. */
export function MyLatestMonthlyReport({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  useEffect(() => {
    if (session.state.status !== 'ready') return;
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: session.state.value.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    router.replace(myMonthlyPath(locale, previousMonth(today)));
  }, [session.state, router, locale]);
  if (session.state.status === 'error') {
    return <ErrorState error={session.state.error} t={t} onRetry={session.reload} />;
  }
  return <LoadingState t={t} rows={4} />;
}
