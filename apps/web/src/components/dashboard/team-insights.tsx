'use client';

import { useId } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { todayIn } from '../../lib/tasks';

import {
  AttendanceRateTile,
  AttendanceTrendCard,
  DepartmentAttendanceCard,
  GoalRateTile,
  GoalStatusCard,
  PeriodSelect,
  Ready,
  TaskPriorityCard,
  TaskRateTiles,
  TaskStatusCard,
  useInsightPeriod,
  useInsightReport,
} from './insight-cards';

/**
 * The business dashboard's charts — attendance, tasks and goals for the
 * owner, admins (the whole company) and managers (their team). Each block
 * reads its company report (`GET /reports/…`), so the API decides the scope:
 * a manager's figures never include another team. One report failing leaves
 * the others standing.
 */
export function TeamInsights({
  locale,
  t,
  timeZone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
}): React.JSX.Element {
  const [period, setPeriod] = useInsightPeriod();
  const today = todayIn(timeZone);
  const selectId = useId();
  const attendance = useInsightReport(locale, 'attendance', period, today);
  const tasks = useInsightReport(locale, 'tasks', period, today);
  const goals = useInsightReport(locale, 'goals', period, today);
  const scope = [attendance, tasks, goals]
    .map((r) => (r.state.status === 'ready' ? r.state.value.report.scope.type : null))
    .find((type) => type !== null);
  const props = { locale, t };

  return (
    <section className="insights" aria-labelledby={`${selectId}-title`}>
      <header className="insights__header">
        <div>
          <h2 id={`${selectId}-title`}>{t('insights.title')}</h2>
          <p>
            {scope === 'team' ? t('insights.scope_team') : t('insights.scope_company')}
            {' · '}
            {t('insights.description')}
          </p>
        </div>
        <PeriodSelect id={selectId} t={t} value={period} onChange={setPeriod} />
      </header>

      <div className="insights__kpis">
        <Ready resource={attendance} t={t} tile>
          {(payload) => <AttendanceRateTile payload={payload} {...props} />}
        </Ready>
        <Ready resource={tasks} t={t} tile>
          {(payload) => <TaskRateTiles payload={payload} {...props} />}
        </Ready>
        <Ready resource={goals} t={t} tile>
          {(payload) => <GoalRateTile payload={payload} {...props} />}
        </Ready>
      </div>

      <div className="insights__grid">
        <Ready resource={attendance} t={t} wide>
          {(payload) => <AttendanceTrendCard payload={payload} today={today} {...props} />}
        </Ready>
        <Ready resource={tasks} t={t}>
          {(payload) => <TaskStatusCard payload={payload} {...props} />}
        </Ready>
        <Ready resource={tasks} t={t}>
          {(payload) => <TaskPriorityCard payload={payload} {...props} />}
        </Ready>
        <Ready resource={goals} t={t}>
          {(payload) => <GoalStatusCard payload={payload} {...props} />}
        </Ready>
        <Ready resource={attendance} t={t}>
          {(payload) => <DepartmentAttendanceCard payload={payload} {...props} />}
        </Ready>
      </div>
    </section>
  );
}
