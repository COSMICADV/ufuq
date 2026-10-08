'use client';

import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { goalPath } from '../../lib/goals';
import type { Goal } from '../../lib/goals';
import { EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { GoalCard } from './goals-shared';

/**
 * The employee profile's Goals tab — DOCUMENT 04 B4: "goal cards with
 * progress".
 *
 * `GET /goals?employee_id=…`, AND-ed on the server with the caller's own
 * `goal.view` scope. Cancelled goals are listed too: they are history.
 */

const PER_PAGE = '100';

export function EmployeeGoals({
  locale,
  t,
  employeeId,
  timeZone,
  assignAction,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly employeeId: string;
  readonly timeZone: string;
  /** The "Assign goal" link, when the caller may create one for this employee. */
  readonly assignAction: React.ReactNode;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<Goal>('/goals', {
        locale,
        signal,
        query: { employee_id: employeeId, per_page: PER_PAGE },
      }),
    [locale, employeeId],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={4} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const goals = resource.state.value.items;
  if (goals.length === 0) {
    return (
      <EmptyState
        title={t('employees.goals_empty_title')}
        description={t('employees.goals_empty')}
        action={assignAction}
      />
    );
  }
  return (
    <div className="tasks-detail">
      {assignAction === null ? null : <div className="tasks-toolbar">{assignAction}</div>}
      <ul className="tasks-cards">
        {goals.map((goal) => (
          <li key={goal.id}>
            <GoalCard
              goal={goal}
              href={goalPath(locale, goal.id)}
              locale={locale}
              t={t}
              timeZone={timeZone}
              showOwner={false}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
