'use client';

import { useCallback } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchMany, fetchOne } from '../../lib/api-client';
import type { MonthlyMatrix } from '../../lib/attendance';
import type { Goal } from '../../lib/goals';
import {
  formatCount,
  formatPercent,
  myAttendanceCounts,
  num,
  percent,
  TASK_STATUS_ORDER,
} from '../../lib/insights';
import { todayIn } from '../../lib/tasks';
import { Card, Skeleton } from '../design-system';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { useResource } from '../settings/use-resource';

import { BarList, RateRing } from './charts';

interface TaskSummary {
  readonly total: number;
  readonly by_status: Readonly<Record<string, number>>;
  readonly overdue: number;
}

interface MyFigures {
  readonly month: ReturnType<typeof myAttendanceCounts> | null;
  readonly tasks: TaskSummary | null;
  readonly goals: readonly Goal[] | null;
}

/**
 * The employee dashboard's charts — the caller's own month: attendance days
 * by status, their tasks by status and their active goals' progress. Every
 * read is under the caller's own scope, so the API decides what is theirs; a
 * part the caller cannot read is simply left out.
 */
export function MyInsights({
  locale,
  t,
  session,
  only,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly session: SessionView;
  /** One part only — the attendance, tasks or goals page shows its own. */
  readonly only?: 'attendance' | 'tasks' | 'goals';
}): React.JSX.Element | null {
  const wants = (part: 'attendance' | 'tasks' | 'goals'): boolean =>
    only === undefined || only === part;
  const canAttendance =
    wants('attendance') &&
    session.employeeId !== null &&
    session.permissions.has('attendance.view');
  const canTasks = wants('tasks') && session.permissions.has('task.view');
  const canGoals = wants('goals') && session.permissions.has('goal.view');

  const load = useCallback(
    async (signal: AbortSignal): Promise<MyFigures> => {
      const month = todayIn(session.timeZone).slice(0, 7);
      const quiet = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
      const [matrix, tasks, goals] = await Promise.all([
        canAttendance
          ? quiet(fetchOne<MonthlyMatrix>(`/attendance/monthly?month=${month}`, { locale, signal }))
          : Promise.resolve(null),
        canTasks
          ? quiet(fetchOne<TaskSummary>('/tasks/summary', { locale, signal }))
          : Promise.resolve(null),
        canGoals
          ? quiet(
              fetchMany<Goal>('/goals', {
                locale,
                signal,
                query: { status: 'active', per_page: '6' },
              }).then((page) => page.items),
            )
          : Promise.resolve(null),
      ]);
      // A manager's matrix holds their team; their own row is the one with their id.
      const own = matrix?.rows.find((row) => row.employee.id === session.employeeId) ?? null;
      return { month: own === null ? null : myAttendanceCounts(own.days), tasks, goals };
    },
    [locale, session.timeZone, session.employeeId, canAttendance, canTasks, canGoals],
  );
  const resource = useResource(load);

  if (!canAttendance && !canTasks && !canGoals) return null;
  if (resource.state.status === 'loading') {
    return (
      <section className="insights">
        <div className="insights__grid">
          <section className="card">
            <Skeleton lines={4} />
          </section>
          <section className="card">
            <Skeleton lines={4} />
          </section>
        </div>
      </section>
    );
  }
  if (resource.state.status === 'error') return null;

  const { month, tasks, goals } = resource.state.value;
  const count = (value: number): string => formatCount(value, locale);

  return (
    <section className="insights" aria-label={t('insights.my_title')}>
      {only === undefined ? (
        <header className="insights__header">
          <h2>{t('insights.my_title')}</h2>
        </header>
      ) : null}
      <div className="insights__grid">
        {month === null ? null : (
          <Card title={t('insights.my_attendance')}>
            <div className="insights__split">
              <RateRing
                value={percent(month.present + month.late + month.half_day, month.workingDays)}
                display={formatPercent(
                  percent(month.present + month.late + month.half_day, month.workingDays),
                  locale,
                )}
                color="var(--semantic-success)"
              />
              <BarList
                caption={t('insights.my_attendance')}
                max={Math.max(1, month.workingDays)}
                bars={[
                  {
                    key: 'present',
                    label: t('attendance.status.present'),
                    value: month.present,
                    color: 'var(--semantic-success)',
                  },
                  {
                    key: 'late',
                    label: t('attendance.status.late'),
                    value: month.late,
                    color: 'var(--semantic-warning)',
                  },
                  {
                    key: 'half_day',
                    label: t('attendance.status.half_day'),
                    value: month.half_day,
                    color: 'var(--chart-2)',
                  },
                  {
                    key: 'on_leave',
                    label: t('attendance.status.on_leave'),
                    value: month.on_leave,
                    color: 'var(--semantic-info)',
                  },
                  {
                    key: 'absent',
                    label: t('attendance.status.absent'),
                    value: month.absent,
                    color: 'var(--semantic-error)',
                  },
                ].map((bar) => ({ ...bar, display: count(bar.value) }))}
              />
            </div>
            <p className="insights__note">
              {t('insights.my_attendance_hint', {
                present: count(month.present + month.late + month.half_day),
                days: count(month.workingDays),
              })}
            </p>
          </Card>
        )}
        {tasks === null || tasks.total === 0 ? null : (
          <Card title={t('insights.my_tasks')}>
            <BarList
              caption={t('insights.my_tasks')}
              bars={[
                ...TASK_STATUS_ORDER.map((status) => ({
                  key: status,
                  label: t(`tasks.status.${status}`),
                  value: tasks.by_status[status] ?? 0,
                  display: count(tasks.by_status[status] ?? 0),
                  color: {
                    not_started: 'var(--border-strong)',
                    in_progress: 'var(--semantic-info)',
                    on_hold: 'var(--semantic-warning)',
                    completed: 'var(--semantic-success)',
                  }[status],
                })),
                {
                  key: 'overdue',
                  label: t('tasks.group.overdue'),
                  value: tasks.overdue,
                  display: count(tasks.overdue),
                  color: 'var(--semantic-error)',
                },
              ]}
            />
          </Card>
        )}
        {goals === null ? null : (
          <Card title={t('insights.my_goals')}>
            {goals.length === 0 ? (
              <p className="chart-empty chart-empty--inline">{t('insights.my_goals_empty')}</p>
            ) : (
              <BarList
                caption={t('insights.my_goals')}
                max={100}
                bars={goals.map((goal) => ({
                  key: goal.id,
                  label: goal.title,
                  value: Math.min(100, num(goal.progress_display_percent)),
                  display: formatPercent(num(goal.progress_percent), locale),
                  color: 'var(--chart-3)',
                }))}
              />
            )}
          </Card>
        )}
      </div>
    </section>
  );
}

/** A section page's own chart for the signed-in person (their attendance, tasks or goals). */
export function MySectionInsights({
  locale,
  only,
}: {
  readonly locale: Locale;
  readonly only: 'attendance' | 'tasks' | 'goals';
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  if (session.state.status !== 'ready') return null;
  return <MyInsights locale={locale} t={t} session={session.state.value} only={only} />;
}
