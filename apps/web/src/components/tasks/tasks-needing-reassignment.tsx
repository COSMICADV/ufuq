'use client';

import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import type { Task } from '../../lib/tasks';
import { Card, EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { TaskTable } from './tasks-admin';

/**
 * "Tasks needing reassignment" — DOCUMENT 13 edge case "Assignee deactivated
 * with open tasks: tasks remain and surface in a … list on the admin
 * dashboard".
 *
 * `GET /tasks?needs_reassignment=true`: open tasks whose assignee is no longer
 * active, inside the caller's scope. Each row links to the task, where
 * "Edit" reassigns it. Once a task is reassigned it leaves this list on the
 * next load. The widget loads, fails and retries on its own, so it never
 * blocks the page (DOCUMENT 04 B1).
 */

/** DOCUMENT 08 §1's maximum page — the whole backlog, not a teaser. */
const PER_PAGE = '100';

export function TasksNeedingReassignment({
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
      fetchMany<Task>('/tasks', {
        locale,
        signal,
        query: { needs_reassignment: 'true', per_page: PER_PAGE },
      }),
    [locale],
  );
  const { state, reload } = useResource(load);

  return (
    <Card
      title={t('tasks.reassignment_title')}
      action={
        state.status === 'ready' && state.value.meta.total > 0 ? (
          <span className="tasks-count">{state.value.meta.total}</span>
        ) : undefined
      }
      className="tasks-reassignment"
    >
      <p className="tasks-muted">{t('tasks.reassignment_description')}</p>
      {state.status === 'loading' ? <LoadingState t={t} rows={4} /> : null}
      {state.status === 'error' ? <ErrorState error={state.error} t={t} onRetry={reload} /> : null}
      {state.status === 'ready' ? (
        state.value.items.length === 0 ? (
          <EmptyState
            title={t('tasks.reassignment_empty_title')}
            description={t('tasks.reassignment_empty')}
            action={null}
          />
        ) : (
          <TaskTable tasks={state.value.items} locale={locale} t={t} timeZone={timeZone} />
        )
      ) : null}
    </Card>
  );
}
