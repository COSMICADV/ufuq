'use client';

import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import { formatDays, isNegative, typeName } from '../../lib/leave';
import type { LeaveBalance } from '../../lib/leave';
import { Card } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

/**
 * Remaining leave per type — DOCUMENT 04 C1 component 6 ("Leave balance:
 * remaining days"), DOCUMENT 16 "Mobile behaviour" (the balance card on the
 * employee dashboard) and B4 Overview ("leave balance").
 *
 * `GET /leave-balances/me` for the caller, or `GET /leave-balances?employee_id=`
 * for a profile (in the caller's `leave.view` scope). Remaining is the
 * server's figure (total + carried − used − pending); a negative remaining
 * (a type that allows it) is shown as such, never hidden. It loads, fails and
 * retries on its own.
 */
export function LeaveBalancesCard({
  locale,
  t,
  employeeId,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  /** Omitted: the caller's own balances. */
  readonly employeeId?: string;
}): React.JSX.Element {
  const load = useCallback(
    async (signal: AbortSignal): Promise<readonly LeaveBalance[]> =>
      employeeId === undefined
        ? fetchOne<readonly LeaveBalance[]>('/leave-balances/me', { locale, signal })
        : (
            await fetchMany<LeaveBalance>('/leave-balances', {
              locale,
              signal,
              query: { employee_id: employeeId, per_page: '100' },
            })
          ).items,
    [locale, employeeId],
  );
  const resource = useResource(load);

  return (
    <Card title={t('leave.balance_title')} className="tasks-reassignment">
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        resource.state.value.length === 0 ? (
          <p className="tasks-muted">{t('leave.balance_empty')}</p>
        ) : (
          <ul className="leave-balances">
            {resource.state.value.map((balance) => (
              <li key={balance.id} className="leave-balances__item">
                <span className="leave-balances__type">{typeName(balance.leave_type, locale)}</span>
                <span className="leave-balances__figure">
                  <strong
                    dir="ltr"
                    className={
                      isNegative(balance.remaining_days) ? 'leave-balances__negative' : undefined
                    }
                  >
                    {formatDays(balance.remaining_days)}
                  </strong>{' '}
                  <span className="tasks-muted">
                    {t('leave.remaining_of', { total: formatDays(balance.total_days) })}
                    {balance.carried_over_days === '0.00'
                      ? null
                      : ` · ${t('leave.carried', { days: formatDays(balance.carried_over_days) })}`}
                  </span>
                </span>
                {balance.pending_days !== '0.00' ? (
                  <span className="tasks-muted">
                    {t('leave.pending_hold', { days: formatDays(balance.pending_days) })}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}
