'use client';

import { useCallback, useId } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { todayIn } from '../../lib/tasks';
import { loadSession } from '../employees/use-session';
import { useResource } from '../settings/use-resource';

import {
  AttendanceMixCard,
  AttendanceRateTile,
  AttendanceTrendCard,
  DepartmentAttendanceCard,
  GoalRateTile,
  GoalStatusCard,
  GoalTypeCard,
  LatenessTile,
  PeriodSelect,
  Ready,
  RemoteTile,
  TaskDepartmentCard,
  TaskPriorityCard,
  TaskRateTiles,
  TaskStatusCard,
  useInsightPeriod,
  useInsightReport,
} from './insight-cards';
import type { InsightReportKey } from './insight-cards';

/**
 * The charts at the top of a section page — attendance, tasks or goals — for
 * the owner, admins (whole company) and managers (their team). A caller who
 * cannot read company reports sees nothing here; the page below is unchanged.
 */
export function SectionInsights({
  locale,
  section,
}: {
  readonly locale: Locale;
  readonly section: InsightReportKey;
}): React.JSX.Element | null {
  const t = createTranslator(locale);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  if (session.state.status !== 'ready') return null;
  const { permissions, timeZone } = session.state.value;
  if (!permissions.has('report.company') && !permissions.has('report.team')) return null;
  return <SectionCharts locale={locale} t={t} section={section} timeZone={timeZone} />;
}

function SectionCharts({
  locale,
  t,
  section,
  timeZone,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly section: InsightReportKey;
  readonly timeZone: string;
}): React.JSX.Element {
  const [period, setPeriod] = useInsightPeriod();
  const today = todayIn(timeZone);
  const id = useId();
  const report = useInsightReport(locale, section, period, today);
  const props = { locale, t };
  const scope = report.state.status === 'ready' ? report.state.value.report.scope.type : null;

  return (
    <section className="insights insights--section" aria-labelledby={`${id}-title`}>
      <header className="insights__header">
        <div>
          <h2 id={`${id}-title`}>{t(`insights.section_${section}`)}</h2>
          <p>{scope === 'team' ? t('insights.scope_team') : t('insights.scope_company')}</p>
        </div>
        <PeriodSelect id={id} t={t} value={period} onChange={setPeriod} />
      </header>
      {section === 'attendance' ? (
        <>
          <div className="insights__kpis">
            <Ready resource={report} t={t} tile>
              {(payload) => (
                <>
                  <AttendanceRateTile payload={payload} {...props} />
                  <LatenessTile payload={payload} {...props} />
                  <RemoteTile payload={payload} {...props} />
                </>
              )}
            </Ready>
          </div>
          <div className="insights__grid">
            <Ready resource={report} t={t} wide>
              {(payload) => <AttendanceTrendCard payload={payload} today={today} {...props} />}
            </Ready>
            <Ready resource={report} t={t}>
              {(payload) => <AttendanceMixCard payload={payload} {...props} />}
            </Ready>
            <Ready resource={report} t={t}>
              {(payload) => <DepartmentAttendanceCard payload={payload} {...props} />}
            </Ready>
          </div>
        </>
      ) : null}
      {section === 'tasks' ? (
        <>
          <div className="insights__kpis">
            <Ready resource={report} t={t} tile>
              {(payload) => <TaskRateTiles payload={payload} {...props} />}
            </Ready>
          </div>
          <div className="insights__grid">
            <Ready resource={report} t={t}>
              {(payload) => <TaskStatusCard payload={payload} {...props} />}
            </Ready>
            <Ready resource={report} t={t}>
              {(payload) => <TaskPriorityCard payload={payload} {...props} />}
            </Ready>
            <Ready resource={report} t={t}>
              {(payload) => <TaskDepartmentCard payload={payload} {...props} />}
            </Ready>
          </div>
        </>
      ) : null}
      {section === 'goals' ? (
        <>
          <div className="insights__kpis">
            <Ready resource={report} t={t} tile>
              {(payload) => <GoalRateTile payload={payload} {...props} />}
            </Ready>
          </div>
          <div className="insights__grid">
            <Ready resource={report} t={t}>
              {(payload) => <GoalStatusCard payload={payload} {...props} />}
            </Ready>
            <Ready resource={report} t={t}>
              {(payload) => <GoalTypeCard payload={payload} {...props} />}
            </Ready>
          </div>
        </>
      ) : null}
    </section>
  );
}
