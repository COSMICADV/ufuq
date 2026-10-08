'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import {
  DASHBOARD_GOALS_LIMIT,
  dueTodayCount,
  isNewcomer,
  nextTasks,
} from '../../lib/employee-dashboard';
import { goalPath, goalsPath } from '../../lib/goals';
import type { Goal } from '../../lib/goals';
import { newRequestPath, requestsPath } from '../../lib/requests';
import type { PendingCount } from '../../lib/requests';
import { taskPath, todayIn } from '../../lib/tasks';
import type { Task } from '../../lib/tasks';
import { AttendanceCard } from '../attendance/attendance-card';
import { formatDate } from '../attendance/attendance-shared';
import { Badge, Card, EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { GoalCard } from '../goals/goals-shared';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';
import { TaskCard } from '../tasks/tasks-admin';

/**
 * `/{locale}/app` — DOCUMENT 04 C1, the employee dashboard.
 *
 * Only the components whose modules exist are rendered: the attendance card
 * (2), "My tasks" (3), "My goals" (4) and, from Phase 9, the requests pending
 * count (7). The greeting carries today's date; salary and leave balance
 * (5–6) arrive with their phases rather than as placeholders (DOCUMENT 27
 * RULE 26).
 *
 * C1 "Loading": the attendance card loads first and on its own — it is the
 * same card as `/app/attendance`, with its own error state and no buttons
 * whose result is unknown. The tasks and goals below it load, fail and retry
 * together, because C1 "Empty" (a welcome card when there are neither) needs
 * both answers.
 *
 * Every list is read under the caller's own scope (`task.view` / `goal.view`
 * "self" for an employee, DOCUMENT 02), so the API decides what is theirs.
 */
export function EmployeeDashboard({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  const ready = session.state.status === 'ready' ? session.state.value : null;

  return (
    <div className="dashboard-widgets">
      {ready === null ? null : (
        <p className="tasks-muted">{formatDate(todayIn(ready.timeZone), locale, ready.timeZone)}</p>
      )}
      <AttendanceCard locale={locale} timeZone={ready?.timeZone ?? 'UTC'} />
      {session.state.status === 'loading' ? <LoadingState t={t} rows={4} /> : null}
      {session.state.status === 'error' ? (
        <ErrorState error={session.state.error} t={t} onRetry={session.reload} />
      ) : null}
      {ready === null ? null : <MyWork locale={locale} t={t} session={ready} />}
      {ready !== null && ready.permissions.has('request.create') ? (
        <MyRequestsCount locale={locale} t={t} />
      ) : null}
    </div>
  );
}

interface WorkView {
  readonly today: string;
  readonly tasks: {
    readonly total: number;
    readonly inProgress: number;
    readonly completed: number;
    readonly overdue: number;
    /** Deadline today or later, in deadline order — "due today" and "next". */
    readonly upcoming: readonly Task[];
  } | null;
  readonly goals: { readonly total: number; readonly items: readonly Goal[] } | null;
}

/** DOCUMENT 08 §1's maximum page. */
const MAX_PAGE = '100';

/** One row is enough to read `meta.total`. */
async function totalOf(
  locale: Locale,
  signal: AbortSignal,
  query: Record<string, string>,
): Promise<number> {
  const page = await fetchMany<Task>('/tasks', {
    locale,
    signal,
    query: { ...query, per_page: '1' },
  });
  return page.meta.total;
}

function MyWork({
  locale,
  t,
  session,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly session: SessionView;
}): React.JSX.Element {
  const canTasks = session.permissions.has('task.view');
  const canGoals = session.permissions.has('goal.view');

  const load = useCallback(
    async (signal: AbortSignal): Promise<WorkView> => {
      const today = todayIn(session.timeZone);
      const [tasks, goals] = await Promise.all([
        canTasks
          ? Promise.all([
              totalOf(locale, signal, {}),
              totalOf(locale, signal, { status: 'in_progress' }),
              totalOf(locale, signal, { status: 'completed' }),
              totalOf(locale, signal, { overdue: 'true' }),
              fetchMany<Task>('/tasks', {
                locale,
                signal,
                query: { from: today, per_page: MAX_PAGE },
              }),
            ]).then(([total, inProgress, completed, overdue, upcoming]) => ({
              total,
              inProgress,
              completed,
              overdue,
              upcoming: upcoming.items,
            }))
          : Promise.resolve(null),
        canGoals
          ? fetchMany<Goal>('/goals', {
              locale,
              signal,
              query: { status: 'active', per_page: String(DASHBOARD_GOALS_LIMIT) },
            }).then((page) => ({ total: page.meta.total, items: page.items }))
          : Promise.resolve(null),
      ]);
      return { today, tasks, goals };
    },
    [locale, session.timeZone, canTasks, canGoals],
  );
  const resource = useResource(load);

  if (resource.state.status === 'loading') {
    return <LoadingState t={t} rows={6} />;
  }
  if (resource.state.status === 'error') {
    return <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />;
  }

  const { today, tasks, goals } = resource.state.value;
  if (isNewcomer({ tasks: tasks?.total ?? 0, goals: goals?.total ?? 0 })) {
    return (
      <EmptyState
        title={t('dashboard.welcome_title')}
        description={t('dashboard.welcome_description')}
        action={null}
      />
    );
  }

  return (
    <>
      {tasks === null ? null : (
        <Card
          title={t('tasks.my_title')}
          className="tasks-reassignment"
          action={
            <Link className="tasks-back" href={`/${locale}/app/tasks`}>
              {t('dashboard.my_tasks_all')}
            </Link>
          }
        >
          <ul className="attendance-chips">
            <li>
              <Badge tone="info">{t('tasks.group.due_today')}</Badge>
              <span dir="ltr">{dueTodayCount(tasks.upcoming, today)}</span>
            </li>
            <li>
              <Badge tone="danger">{t('tasks.group.overdue')}</Badge>
              <span dir="ltr">{tasks.overdue}</span>
            </li>
            <li>
              <Badge tone="warning">{t('tasks.group.in_progress')}</Badge>
              <span dir="ltr">{tasks.inProgress}</span>
            </li>
            <li>
              <Badge tone="success">{t('tasks.group.completed')}</Badge>
              <span dir="ltr">{tasks.completed}</span>
            </li>
          </ul>
          <NextTasks
            locale={locale}
            t={t}
            timeZone={session.timeZone}
            tasks={nextTasks(tasks.upcoming, today)}
          />
        </Card>
      )}

      {goals === null ? null : (
        <Card
          title={t('goals.my_title')}
          className="tasks-reassignment"
          action={
            <Link className="tasks-back" href={goalsPath(locale, 'app')}>
              {t('dashboard.my_goals_all')}
            </Link>
          }
        >
          {goals.items.length === 0 ? (
            <p className="tasks-muted">{t('dashboard.my_goals_empty')}</p>
          ) : (
            <ul className="tasks-cards">
              {goals.items.map((goal) => (
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
          )}
        </Card>
      )}
    </>
  );
}

function NextTasks({
  locale,
  t,
  timeZone,
  tasks,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly tasks: readonly Task[];
}): React.JSX.Element {
  if (tasks.length === 0) {
    return <p className="tasks-muted">{t('dashboard.next_tasks_empty')}</p>;
  }
  return (
    <section className="tasks-group" aria-labelledby="dashboard-next-tasks">
      <h4 id="dashboard-next-tasks">{t('dashboard.next_tasks_title')}</h4>
      <ul className="tasks-cards">
        {tasks.map((task) => (
          <li key={task.id}>
            <TaskCard
              task={task}
              href={taskPath(locale, task.id, 'app')}
              locale={locale}
              t={t}
              timeZone={timeZone}
              showAssignee={false}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * C1 component 7 — "Requests: pending count", from `GET /requests/pending-count`.
 * For an employee that is their own pending requests; for a reviewer it is
 * what awaits their decision, and the link goes to the inbox. It loads, fails
 * and retries on its own, like the attendance card.
 */
function MyRequestsCount({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element {
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<PendingCount>('/requests/pending-count', { locale, signal }),
    [locale],
  );
  const resource = useResource(load);
  const review = resource.state.status === 'ready' && resource.state.value.basis === 'review';

  return (
    <Card
      title={t('requests.my_title')}
      className="tasks-reassignment"
      action={
        <Link className="tasks-back" href={newRequestPath(locale)}>
          {t('requests.new_request')}
        </Link>
      }
    >
      {resource.state.status === 'loading' ? <LoadingState t={t} rows={1} /> : null}
      {resource.state.status === 'error' ? (
        <ErrorState error={resource.state.error} t={t} onRetry={resource.reload} />
      ) : null}
      {resource.state.status === 'ready' ? (
        <ul className="attendance-chips">
          <li>
            <Badge tone="warning">
              {review ? t('dashboard.requests_awaiting_review') : t('dashboard.requests_pending')}
            </Badge>
            <span dir="ltr">{resource.state.value.count}</span>
          </li>
          <li>
            <Link href={review ? requestsPath(locale) : requestsPath(locale, 'app')}>
              {review ? t('dashboard.requests_open_inbox') : t('dashboard.requests_all')}
            </Link>
          </li>
        </ul>
      ) : null}
    </Card>
  );
}
