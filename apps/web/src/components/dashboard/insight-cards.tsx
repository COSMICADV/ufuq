'use client';

/**
 * The chart cards behind every "insights" section — the dashboard's and each
 * section page's (attendance, tasks, goals). Each card takes the report the
 * API already scoped (`GET /reports/…`): the whole company for the owner and
 * admins, the caller's team for a manager.
 */

import { useCallback, useState } from 'react';
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
import { Card, Select, Skeleton } from '../design-system';
import { useResource } from '../settings/use-resource';
import type { Resource, ResourceHandle } from '../settings/use-resource';

import { BarList, RateTile, StackedColumns } from './charts';
import type { Series } from './charts';

// ---------------------------------------------------------------------------
// Period and data
// ---------------------------------------------------------------------------

const PERIOD_STORAGE_KEY = '1to1os.insights.period';

function storedPeriod(): InsightPeriod {
  try {
    const value = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return value !== null && isInsightPeriod(value) ? value : 'month';
  } catch {
    return 'month';
  }
}

/** The chosen period, shared by every insights section and remembered in this browser. */
export function useInsightPeriod(): [InsightPeriod, (next: InsightPeriod) => void] {
  const [period, setPeriod] = useState<InsightPeriod>(() =>
    typeof window === 'undefined' ? 'month' : storedPeriod(),
  );
  const choose = (next: InsightPeriod): void => {
    setPeriod(next);
    try {
      window.localStorage.setItem(PERIOD_STORAGE_KEY, next);
    } catch {
      // Not remembered; the choice still applies now.
    }
  };
  return [period, choose];
}

export function PeriodSelect({
  id,
  t,
  value,
  onChange,
}: {
  readonly id: string;
  readonly t: Translator;
  readonly value: InsightPeriod;
  readonly onChange: (next: InsightPeriod) => void;
}): React.JSX.Element {
  return (
    <label className="insights__period" htmlFor={id}>
      <span>{t('insights.period_label')}</span>
      <Select
        id={id}
        value={value}
        onChange={(event) => {
          if (isInsightPeriod(event.target.value)) onChange(event.target.value);
        }}
      >
        {INSIGHT_PERIODS.map((p) => (
          <option key={p} value={p}>
            {t(`insights.period.${p}`)}
          </option>
        ))}
      </Select>
    </label>
  );
}

export type InsightReportKey = 'attendance' | 'tasks' | 'goals';

/** One report for the period, first page only — the charts read its summary, groups and trend. */
export function useInsightReport(
  locale: Locale,
  key: InsightReportKey,
  period: InsightPeriod,
  today: string,
): ResourceHandle<ReportPayload> {
  const range = periodRange(period, today);
  const load = useCallback(
    (signal: AbortSignal) =>
      fetchOne<ReportPayload>(`/reports/${key}`, {
        locale,
        signal,
        query: { from: range.from, to: range.to, page: '1', per_page: '1' },
      }),
    [locale, key, range.from, range.to],
  );
  return useResource(load);
}

/** Renders a block once its report is in; a skeleton before, a quiet note on failure. */
export function Ready({
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

interface CardProps {
  readonly payload: ReportPayload;
  readonly locale: Locale;
  readonly t: Translator;
}

function counter(locale: Locale): (value: number) => string {
  return (value) => formatCount(value, locale);
}

function Empty({ t }: { readonly t: Translator }): React.JSX.Element {
  return <p className="chart-empty chart-empty--inline">{t('insights.empty')}</p>;
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export function AttendanceRateTile({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = attendanceTotals(payload.summary);
  const count = counter(locale);
  return (
    <RateTile
      label={t('insights.kpi_attendance')}
      value={totals.rate}
      display={formatPercent(totals.rate, locale)}
      color="var(--semantic-success)"
      hint={t('insights.kpi_attendance_hint', {
        present: count(totals.present),
        days: count(totals.workingDays),
      })}
    />
  );
}

export function LatenessTile({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = attendanceTotals(payload.summary);
  const count = counter(locale);
  return (
    <RateTile
      label={t('insights.kpi_late')}
      value={totals.lateRate}
      display={formatPercent(totals.lateRate, locale)}
      color="var(--semantic-warning)"
      hint={t('insights.kpi_late_hint', { late: count(totals.late) })}
    />
  );
}

export function RemoteTile({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = attendanceTotals(payload.summary);
  const rate = totals.present > 0 ? (totals.wfh / totals.present) * 100 : null;
  return (
    <RateTile
      label={t('insights.kpi_wfh')}
      value={rate}
      display={formatPercent(rate, locale)}
      color="var(--chart-3)"
      hint={t('insights.kpi_wfh_hint', { wfh: counter(locale)(totals.wfh) })}
    />
  );
}

export function AttendanceTrendCard({
  payload,
  locale,
  t,
  today,
}: CardProps & { readonly today: string }): React.JSX.Element {
  const count = counter(locale);
  const daily = payload.report.trend_unit === 'day';
  const days = attendanceTrend(payload, today);
  const title = daily ? t('insights.attendance_by_day') : t('insights.attendance_by_month');
  const series: Series[] = [
    { key: 'present', label: t('attendance.status.present'), color: 'var(--semantic-success)' },
    { key: 'leave', label: t('attendance.status.on_leave'), color: 'var(--semantic-info)' },
    { key: 'absent', label: t('attendance.status.absent'), color: 'var(--semantic-error)' },
  ];
  return (
    <Card title={title} className="insights__wide">
      <StackedColumns
        series={series}
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
}

export function AttendanceMixCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = attendanceTotals(payload.summary);
  const count = counter(locale);
  const office = Math.max(0, totals.present - totals.wfh);
  const bars = [
    {
      key: 'office',
      label: t('insights.in_office'),
      value: office,
      color: 'var(--semantic-success)',
    },
    { key: 'wfh', label: t('insights.from_home'), value: totals.wfh, color: 'var(--chart-3)' },
    {
      key: 'late',
      label: t('attendance.status.late'),
      value: totals.late,
      color: 'var(--semantic-warning)',
    },
    {
      key: 'leave',
      label: t('attendance.status.on_leave'),
      value: totals.leave,
      color: 'var(--semantic-info)',
    },
    {
      key: 'absent',
      label: t('attendance.status.absent'),
      value: totals.absent,
      color: 'var(--semantic-error)',
    },
  ].map((bar) => ({ ...bar, display: count(bar.value) }));
  return (
    <Card title={t('insights.attendance_mix')}>
      {totals.workingDays === 0 ? (
        <Empty t={t} />
      ) : (
        <BarList bars={bars} caption={t('insights.attendance_mix')} max={totals.workingDays} />
      )}
    </Card>
  );
}

export function DepartmentAttendanceCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const count = counter(locale);
  const departments = departmentAttendance(payload.groups.by_department, locale);
  return (
    <Card title={t('insights.departments')}>
      {departments.length === 0 || departments.every((d) => d.rate === null) ? (
        <Empty t={t} />
      ) : (
        <BarList
          caption={t('insights.departments')}
          max={100}
          bars={departments.map((d) => ({
            key: d.id || 'none',
            label: (
              <>
                {d.name ?? t('insights.no_department')}
                <small>{t('insights.employees_count', { count: count(d.employees) })}</small>
              </>
            ),
            value: d.rate ?? 0,
            display: formatPercent(d.rate, locale),
            color: 'var(--chart-1)',
          }))}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function TaskRateTiles({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = taskTotals(payload.summary);
  const count = counter(locale);
  return (
    <>
      <RateTile
        label={t('insights.kpi_completion')}
        value={totals.completionRate}
        display={formatPercent(totals.completionRate, locale)}
        hint={t('insights.kpi_completion_hint', {
          completed: count(totals.byStatus.completed),
          assigned: count(totals.assigned),
        })}
      />
      <RateTile
        label={t('insights.kpi_on_time')}
        value={totals.onTimeRate}
        display={formatPercent(totals.onTimeRate, locale)}
        color="var(--chart-2)"
        hint={t('insights.kpi_on_time_hint', { overdue: count(totals.overdue) })}
      />
    </>
  );
}

const TASK_STATUS_COLORS: Record<(typeof TASK_STATUS_ORDER)[number], string> = {
  not_started: 'var(--border-strong)',
  in_progress: 'var(--semantic-info)',
  on_hold: 'var(--semantic-warning)',
  completed: 'var(--semantic-success)',
};

export function TaskStatusCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = taskTotals(payload.summary);
  const count = counter(locale);
  const bars = [
    ...TASK_STATUS_ORDER.map((status) => ({
      key: status,
      label: t(`tasks.status.${status}`),
      value: totals.byStatus[status],
      display: count(totals.byStatus[status]),
      color: TASK_STATUS_COLORS[status],
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
        <Empty t={t} />
      ) : (
        <BarList bars={bars} caption={t('insights.tasks_by_status')} />
      )}
    </Card>
  );
}

export function TaskPriorityCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const count = counter(locale);
  const load = priorityLoad(payload.groups.by_priority);
  const series: Series[] = [
    { key: 'completed', label: t('tasks.status.completed'), color: 'var(--semantic-success)' },
    { key: 'open', label: t('insights.still_open'), color: 'var(--chart-open)' },
  ];
  return (
    <Card title={t('insights.tasks_by_priority')}>
      {load.length === 0 ? (
        <Empty t={t} />
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
}

/** Completion rate per department, best first. */
export function TaskDepartmentCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const count = counter(locale);
  const rows = [...(payload.groups.by_department ?? [])]
    .map((row) => ({
      id: (row.department_id as string | null) ?? 'none',
      name:
        ((locale === 'ar' ? row.department_name_ar : row.department_name_en) as string | null) ??
        null,
      assigned: Number(row.assigned ?? 0),
      completed: Number(row.completed ?? 0),
    }))
    .filter((row) => row.assigned > 0)
    .sort((a, b) => b.completed / b.assigned - a.completed / a.assigned);
  return (
    <Card title={t('insights.tasks_by_department')}>
      {rows.length === 0 ? (
        <Empty t={t} />
      ) : (
        <BarList
          caption={t('insights.tasks_by_department')}
          max={100}
          bars={rows.map((row) => ({
            key: row.id,
            label: (
              <>
                {row.name ?? t('insights.no_department')}
                <small>
                  {count(row.completed)} / {count(row.assigned)}
                </small>
              </>
            ),
            value: (row.completed / row.assigned) * 100,
            display: formatPercent((row.completed / row.assigned) * 100, locale),
            color: 'var(--chart-1)',
          }))}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export function GoalRateTile({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = goalTotals(payload.summary);
  const count = counter(locale);
  return (
    <RateTile
      label={t('insights.kpi_goals')}
      value={totals.achievementRate}
      display={formatPercent(totals.achievementRate, locale)}
      color="var(--chart-3)"
      hint={t('insights.kpi_goals_hint', {
        achieved: count(totals.achieved),
        missed: count(totals.missed),
        active: count(totals.active),
      })}
    />
  );
}

export function GoalStatusCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const totals = goalTotals(payload.summary);
  const count = counter(locale);
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
        <Empty t={t} />
      ) : (
        <BarList bars={bars} caption={t('insights.goals_by_status')} />
      )}
    </Card>
  );
}

/** Goals per type (sales, tasks, custom) with how many were achieved. */
export function GoalTypeCard({ payload, locale, t }: CardProps): React.JSX.Element {
  const count = counter(locale);
  const rows = (payload.groups.by_type ?? [])
    .map((row) => ({
      type: String(row.goal_type ?? row.type ?? 'custom'),
      goals: Number(row.goals ?? 0),
      achieved: Number(row.achieved ?? 0),
    }))
    .filter((row) => row.goals > 0);
  const series: Series[] = [
    { key: 'achieved', label: t('goals.status.achieved'), color: 'var(--semantic-success)' },
    { key: 'rest', label: t('insights.not_yet'), color: 'var(--chart-open)' },
  ];
  return (
    <Card title={t('insights.goals_by_type')}>
      {rows.length === 0 ? (
        <Empty t={t} />
      ) : (
        <BarList
          caption={t('insights.goals_by_type')}
          series={series}
          bars={rows.map((row) => ({
            key: row.type,
            label: t(`goals.type.${row.type}`),
            value: row.goals,
            display: `${count(row.achieved)} / ${count(row.goals)}`,
            color: 'var(--chart-open)',
            part: { value: row.achieved, color: 'var(--semantic-success)' },
          }))}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG' : 'en-GB';
}
export function dayLabel(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
export function fullDay(day: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}
export function monthLabel(month: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}
