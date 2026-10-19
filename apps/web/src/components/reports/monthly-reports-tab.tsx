'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { employeePath } from '../../lib/employees';
import { monthLabel } from '../../lib/payroll';
import { isMonthKey, previousMonth } from '../../lib/reports';
import type { MonthlyReportListItem } from '../../lib/reports';
import { Badge, Card } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { MonthlyReportView } from './monthly-report';

/**
 * DOCUMENT 04 B4, Monthly Reports tab: "month list → report viewer". The
 * month is in the URL (`?month=YYYY-MM`) so a report is addressable; without
 * one, the newest generated report (or last month) opens.
 */
export function MonthlyReportsTab({
  locale,
  t,
  employeeId,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
}): React.JSX.Element {
  const params = useSearchParams();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, list] = await Promise.all([
        loadSession(locale, signal),
        fetchOne<readonly MonthlyReportListItem[]>(`/employees/${employeeId}/monthly-reports`, {
          locale,
          signal,
        }),
      ]);
      return { session, list };
    },
    [locale, employeeId],
  );
  const resource = useResource(load);
  const href = (month: string): string =>
    `${employeePath(locale, employeeId, 'reports')}?month=${month}`;

  if (resource.state.status === 'loading') return <LoadingState t={t} rows={4} />;
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, list } = resource.state.value;
  const requested = params.get('month');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: session.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const month =
    requested !== null && isMonthKey(requested)
      ? requested
      : (list[0]?.month_key ?? previousMonth(today));

  return (
    <div className="monthly-tab">
      <Card title={t('reports.monthly.list_title')} className="monthly-tab__list report-no-print">
        {list.length === 0 ? (
          <p className="tasks-muted">{t('reports.monthly.list_empty')}</p>
        ) : (
          <ul>
            {list.map((item) => (
              <li key={item.id} className={item.month_key === month ? 'is-current' : ''}>
                <Link
                  href={href(item.month_key)}
                  {...(item.month_key === month ? { 'aria-current': 'page' as const } : {})}
                >
                  {monthLabel(
                    Number(item.month_key.slice(0, 4)),
                    Number(item.month_key.slice(5, 7)),
                    locale,
                  )}
                </Link>
                {item.overall_score === null ? null : (
                  <span dir="ltr">{`${item.overall_score}%`}</span>
                )}
                {item.is_provisional ? (
                  <Badge tone="warning">{t('reports.provisional_badge')}</Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <MonthlyReportView
        key={month}
        locale={locale}
        employeeId={employeeId}
        month={month}
        monthHref={href}
        onChange={resource.reload}
      />
    </div>
  );
}
