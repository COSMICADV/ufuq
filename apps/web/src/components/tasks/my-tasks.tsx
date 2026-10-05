'use client';

import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchMany } from '../../lib/api-client';
import { groupMyTasks, taskPath, todayIn } from '../../lib/tasks';
import type { Task } from '../../lib/tasks';
import { EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { TaskCard } from './tasks-admin';

/**
 * `/{locale}/app/tasks` — DOCUMENT 04 C5, DOCUMENT 13 "Mobile behaviour".
 *
 * Grouped: Due today · Overdue · In progress · Not started · Completed (on
 * hold and cancelled follow, so nothing assigned disappears). Cards are full
 * width and tappable — this is a primary mobile screen.
 *
 * The list is `GET /tasks` under the caller's own `task.view` scope, which for
 * an employee is "self (assigned)" (DOCUMENT 02). Grouping is presentation;
 * overdue is the server's flag, measured against the company's day.
 */

/** DOCUMENT 08 §1's maximum page; an employee's open work fits well within it. */
const PER_PAGE = '100';

export function MyTasks({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const [session, tasks] = await Promise.all([
        loadSession(locale, signal),
        fetchMany<Task>('/tasks', { locale, signal, query: { per_page: PER_PAGE } }),
      ]);
      return { session, tasks: tasks.items };
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

  const { session, tasks } = resource.state.value;
  if (tasks.length === 0) {
    return (
      <EmptyState
        title={t('tasks.my_empty_title')}
        description={t('tasks.my_empty_description')}
        action={null}
      />
    );
  }

  const groups = groupMyTasks(tasks, todayIn(session.timeZone));
  return (
    <div className="tasks-groups">
      {groups.map(({ group, tasks: inGroup }) => (
        <section key={group} className="tasks-group" aria-labelledby={`group-${group}`}>
          <header className="tasks-board__header">
            <h2 id={`group-${group}`}>{t(`tasks.group.${group}`)}</h2>
            <span className="tasks-count">{inGroup.length}</span>
          </header>
          <ul className="tasks-cards">
            {inGroup.map((task) => (
              <li key={task.id}>
                <TaskCard
                  task={task}
                  href={taskPath(locale, task.id, 'app')}
                  locale={locale}
                  t={t}
                  timeZone={session.timeZone}
                  showAssignee={false}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
