'use client';

import { useCallback, useId, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import {
  attendanceTotals,
  attendanceTrend,
  departmentAttendance,
  formatCount,
  formatPercent,
  goalTotals,
  INSIGHT_PERIODS,
  isInsightPeriod,
  periodRange,
  priorityLoad,
  TASK_STATUS_ORDER,
  taskTotals,
} from '../../lib/insights';
import type { InsightPeriod } from '../../lib/insights';
import type { ReportPayload } from '../../lib/reports';
import { todayIn } from '../../lib/tasks';
import { Card, Select, Skeleton } from '../design-system';
import { useResource } from '../settings/use-resource';
import type { Resource } from '../settings/use-resource';

import { BarList, RateTile, StackedColumns } from './charts';
import type { Series } from './charts';

const PERIOD_STORAGE_KEY = '1to1os.insights.period';

function storedPeriod(): InsightPeriod {
  try {
    const value = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return value !== null && isInsightPeriod(value) ? value : 'month';
  } catch {
    return 'month';
  }
}

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
  const [period, setPeriod] = useState<InsightPeriod>(() =>
    typeof window === 'undefined' ? 'month' : storedPeriod(),
  );
  const today = todayIn(timeZone);
  const range = periodRange(period, today);
  const selectId = useId();

  const report = (key: 'attendance' | 'tasks' | 'goals') => (signal: AbortSignal) =>
    fetchOne<ReportPayload>(`/reports/${key}`, {
      locale,
      signal,
      query: { from: range.from, to: range.to, page: '1', per_page: '1' },
    });
  const attendance = useResource(useCallback(report('attendance'), [locale, range.from, range.to]));
  const tasks = useResource(useCallback(report('tasks'), [locale, range.from, range.to]));
  const goals = useResource(useCallback(report('goals'), [locale, range.from, range.to]));

  const scope = [attendance, tasks, goals]
    .map((r) => (r.state.status === 'ready' ? r.state.value.report.scope.type : null))
    .find((type) => type !== null);

  const count = (value: number): string => formatCount(value, locale);
  const pct = (value: number | null): string => formatPercent(value, locale);

  const attendanceSeries: Series[] = [
    { key: 'present', label: t('attendance.status.present'), color: 'var(--semantic-success)' },
    { key: 'leave', label: t('attendance.status.on_leave'), color: 'var(--semantic-info)' },
    { key: 'absent', label: t('attendance.status.absent'), color: 'var(--semantic-error)' },
  ];

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
        <label className="insights__period" htmlFor={selectId}>
          <span>{t('insights.period_label')}</span>
          <Select
            id={selectId}
            value={period}
            onChange={(event) => {
              const next = event.target.value;
              if (!isInsightPeriod(next)) return;
              setPeriod(next);
              try {
                window.localStorage.setItem(PERIOD_STORAGE_KEY, next);
              } catch {
                // Not remembered; the choice still applies now.
              }
            }}
          >
            {INSIGHT_PERIODS.map((p) => (
              <option key={p} value={p}>
                {t(`insights.period.${p}`)}
              </option>
            ))}
          </Select>
        </label>
      </header>

      <div className="insights__kpis">
        <Ready resource={attendance} t={t} tile>
          {(payload) => {
            const totals = attendanceTotals(payload.summary);
            return (
              <RateTile
                label={t('insights.kpi_attendance')}
                value={totals.rate}
                display={pct(totals.rate)}
                color="var(--semantic-success)"
                hint={t('insights.kpi_attendance_hint', {
                  present: count(totals.present),
                  days: count(totals.workingDays),
                })}
              />
            );
          }}
        </Ready>
        <Ready resource={tasks} t={t} tile>
          {(payload) => {
            const totals = taskTotals(payload.summary);
            return (
              <>
                <RateTile
                  label={t('insights.kpi_completion')}
                  value={totals.completionRate}
                  display={pct(totals.completionRate)}
                  hint={t('insights.kpi_completion_hint', {
                    completed: count(totals.byStatus.completed),
                    assigned: count(totals.assigned),
                  })}
                />
                <RateTile
                  label={t('insights.kpi_on_time')}
                  value={totals.onTimeRate}
                  display={pct(totals.onTimeRate)}
                  color="var(--chart-2)"
                  hint={t('insights.kpi_on_time_hint', { overdue: count(totals.overdue) })}
                />
              </>
            );
          }}
        </Ready>
        <Ready resource={goals} t={t} tile>
          {(payload) => {
            const totals = goalTotals(payload.summary);
            return (
              <RateTile
                label={t('insights.kpi_goals')}
                value={totals.achievementRate}
                display={pct(totals.achievementRate)}
                color="var(--chart-3)"
                hint={t('insights.kpi_goals_hint', {
                  achieved: count(totals.achieved),
                  missed: count(totals.missed),
                  active: count(totals.active),
                })}
              />
            );
          }}
        </Ready>
      </div>

      <div className="insights__grid">
        <Ready resource={attendance} t={t} wide>
          {(payload) => {
            const daily = payload.report.trend_unit === 'day';
            const days = attendanceTrend(payload, today);
            const title = daily
              ? t('insights.attendance_by_day')
              : t('insights.attendance_by_month');
            return (
              <Card title={title} className="insights__wide">
                <StackedColumns
                  series={attendanceSeries}
                  caption={title}
                  format={count}
                  emptyText={t('insights.empty')}
                  columns={days.map((day) => ({
                    key: day.period,
                    label: daily ? dayLabel(day.period, locale) : monthLabel(day.period, locale),
                    title: daily ? fullDay(day.period, locale) : monthLabel(day.period, locale),
                    values: { present: day.present, leave: day.leave, absent: day.absent },
                    notes: [
                      { label: t('insights.of_which_late'), value: count(day.late) },
                      { label: t('insights.of_which_wfh'), value: count(day.wfh) },
                    ],
                  }))}
                />
              </Card>
            );
          }}
        </Ready>

        <Ready resource={tasks} t={t}>
          {(payload) => {
            const totals = taskTotals(payload.summary);
            const colors: Record<(typeof TASK_STATUS_ORDER)[number], string> = {
              not_started: 'var(--border-strong)',
              in_progress: 'var(--semantic-info)',
              on_hold: 'var(--semantic-warning)',
              completed: 'var(--semantic-success)',
            };
            const bars = [
              ...TASK_STATUS_ORDER.map((status) => ({
                key: status,
                label: t(`tasks.status.${status}`),
                value: totals.byStatus[status],
                display: count(totals.byStatus[status]),
                color: colors[status],
              })),
              {
                key: 'overdue',
                label: t('tasks.group.overdue'),
                value: totals.overdue,
                display: count(totals.overdue),
                color: 'var(--semantic-error)',
              },
            ];
            return (
              <Card title={t('insights.tasks_by_status')}>
                {totals.assigned === 0 ? (
                  <p className="chart-empty chart-empty--inline">{t('insights.empty')}</p>
                ) : (
                  <BarList bars={bars} caption={t('insights.tasks_by_status')} />
                )}
              </Card>
            );
          }}
        </Ready>

        <Ready resource={tasks} t={t}>
          {(payload) => {
            const load = priorityLoad(payload.groups.by_priority);
            const series: Series[] = [
              {
                key: 'completed',
                label: t('tasks.status.completed'),
                color: 'var(--semantic-success)',
              },
              { key: 'open', label: t('insights.still_open'), color: 'var(--chart-open)' },
            ];
            return (
              <Card title={t('insights.tasks_by_priority')}>
                {load.length === 0 ? (
                  <p className="chart-empty chart-empty--inline">{t('insights.empty')}</p>
                ) : (
                  <BarList
                    caption={t('insights.tasks_by_priority')}
                    series={series}
                    bars={load.map((row) => ({
                      key: row.priority,
                      label: t(`tasks.priority.${row.priority}`),
                      value: row.assigned,
                      display: `${count(row.completed)} / ${count(row.assigned)}`,
                      color: 'var(--chart-open)',
                      part: { value: row.completed, color: 'var(--semantic-success)' },
                    }))}
                  />
                )}
              </Card>
            );
          }}
        </Ready>

        <Ready resource={goals} t={t}>
          {(payload) => {
            const totals = goalTotals(payload.summary);
            const bars = [
              {
                key: 'active',
                label: t('goals.status.active'),
                value: totals.active,
                color: 'var(--semantic-info)',
              },
              {
                key: 'achieved',
                label: t('goals.status.achieved'),
                value: totals.achieved,
                color: 'var(--semantic-success)',
              },
              {
                key: 'missed',
                label: t('goals.status.missed'),
                value: totals.missed,
                color: 'var(--semantic-error)',
              },
            ].map((bar) => ({ ...bar, display: count(bar.value) }));
            return (
              <Card title={t('insights.goals_by_status')}>
                {totals.goals === 0 ? (
                  <p className="chart-empty chart-empty--inline">{t('insights.empty')}</p>
                ) : (
                  <BarList bars={bars} caption={t('insights.goals_by_status')} />
                )}
              </Card>
            );
          }}
        </Ready>

        <Ready resource={attendance} t={t}>
          {(payload) => {
            const departments = departmentAttendance(payload.groups.by_department, locale);
            return (
              <Card title={t('insights.departments')}>
                {departments.length === 0 || departments.every((d) => d.rate === null) ? (
                  <p className="chart-empty chart-empty--inline">{t('insights.empty')}</p>
                ) : (
                  <BarList
                    caption={t('insights.departments')}
                    max={100}
                    bars={departments.map((d) => ({
                      key: d.id || 'none',
                      label: (
                        <>
                          {d.name ?? t('insights.no_department')}
                          <small>
                            {t('insights.employees_count', { count: count(d.employees) })}
                          </small>
                        </>
                      ),
                      value: d.rate ?? 0,
                      display: pct(d.rate),
                      color: 'var(--chart-1)',
                    }))}
                  />
                )}
              </Card>
            );
          }}
        </Ready>
      </div>
    </section>
  );
}

/** Renders a block once its report is in; a skeleton before, a quiet note on failure. */
function Ready({
  resource,
  t,
  tile = false,
  wide = false,
  children,
}: {
  readonly resource: { readonly state: Resource<ReportPayload> };
  readonly t: Translator;
  readonly tile?: boolean;
  readonly wide?: boolean;
  readonly children: (payload: ReportPayload) => React.JSX.Element;
}): React.JSX.Element {
  const className = [tile ? 'rate-tile' : '', wide ? 'insights__wide' : ''].join(' ').trim();
  if (resource.state.status === 'loading') {
    return (
      <section className={`card ${className}`}>
        <Skeleton lines={tile ? 2 : 5} />
      </section>
    );
  }
  if (resource.state.status === 'error') {
    return (
      <section className={`card ${className}`}>
        <p className="chart-empty chart-empty--inline">{t('insights.unavailable')}</p>
      </section>
    );
  }
  return children(resource.state.value);
}

function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG' : 'en-GB';
}
function dayLabel(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
function fullDay(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
function monthLabel(month: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}
