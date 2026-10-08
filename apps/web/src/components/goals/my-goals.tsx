'use client';

import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { goalPath } from '../../lib/goals';
import type { Goal } from '../../lib/goals';
import { EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { GoalCard } from './goals-shared';

/**
 * `/{locale}/app/goals` — DOCUMENT 03 §4 "My goals", the goal cards DOCUMENT
 * 14 places on the employee app.
 *
 * `GET /goals` under the caller's own `goal.view` scope, which for an
 * employee is their own goals (DOCUMENT 02). Read-only: a card opens the
 * goal, which has no editing affordances on this surface. DOCUMENT 14
 * "Mobile behaviour": full-width cards with a progress bar, current and
 * target values, and days remaining.
 */

/** DOCUMENT 08 §1's maximum page; one person's goals fit well within it. */
const PER_PAGE = '100';

export function MyGoals({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, goals] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Goal>('/goals', { locale, signal, query: { per_page: PER_PAGE } }),
      ]);
      return { session, goals: goals.items };
    },
    [locale],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={6} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }
  const { session, goals } = resource.state.value;
  if (goals.length === 0) {
    return (
      <EmptyState
        title={t('goals.my_empty_title')}
        description={t('goals.my_empty_description')}
        action={null}
      />
    );
  }
  return (
    <ul className="tasks-cards">
      {goals.map((goal) => (
        <li key={goal.id}>
          <GoalCard
            goal={goal}
            href={goalPath(locale, goal.id, 'app')}
            locale={locale}
            t={t}
            timeZone={session.timeZone}
            showOwner={false}
          />
        </li>
      ))}
    </ul>
  );
}
