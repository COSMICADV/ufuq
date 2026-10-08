'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { goalPath, goalsPath } from '../../lib/goals';
import type { Goal } from '../../lib/goals';
import { Card } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { GoalCard } from './goals-shared';

/**
 * DOCUMENT 04 B1 widget 6 — "Goal progress: top 5 goals by proximity to
 * deadline with progress bars".
 *
 * Active goals only, nearest period end first — the API's own list order —
 * under the caller's `goal.view` scope, so a manager sees their team. It loads,
 * fails and retries on its own, like every dashboard widget.
 */
export function GoalProgressWidget({
  locale,
  t,
  timeZone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchMany<Goal>('/goals', {
        locale,
        signal,
        query: { status: 'active', per_page: '5' },
      }),
    [locale],
  );
  const resource = useResource(load);

  return (
    <Card
      title={t('dashboard.goal_progress_title')}
      className="tasks-reassignment"
      action={
        <Link className="tasks-back" href={goalsPath(locale)}>
          {t('dashboard.goal_progress_all')}
        </Link>
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={3} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        resource.state.value.items.length === 0 ? (
          <p className="tasks-muted">{t('dashboard.goal_progress_empty')}</p>
        ) : (
          <ul className="tasks-cards">
            {resource.state.value.items.map((goal) => (
              <li key={goal.id}>
                <GoalCard
                  goal={goal}
                  href={goalPath(locale, goal.id)}
                  locale={locale}
                  t={t}
                  timeZone={timeZone}
                />
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}
