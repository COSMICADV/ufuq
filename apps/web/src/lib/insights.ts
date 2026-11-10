/**
 * Dashboard charts — the figures behind them, as pure functions.
 *
 * The business dashboard (owner, admin, manager) reads the company reports
 * the API already scopes (`GET /reports/{attendance|tasks|goals}`: the whole
 * company for `report.company`, the caller's team for `report.team`). The
 * employee dashboard reads the caller's own records. Nothing here decides a
 * figure the API did not send; it only shapes it for a chart.
 */

import type { Cell, ReportPayload, ReportRow } from './reports';

// ---------------------------------------------------------------------------
// Period
// ---------------------------------------------------------------------------

export const INSIGHT_PERIODS = ['month', '30d', '90d'] as const;
export type InsightPeriod = (typeof INSIGHT_PERIODS)[number];

export function isInsightPeriod(value: string): value is InsightPeriod {
  return (INSIGHT_PERIODS as readonly string[]).includes(value);
}

/** `YYYY-MM-DD` arithmetic in UTC — calendar days, never instants. */
export function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** The inclusive range a period covers, ending today (the company's day). */
export function periodRange(
  period: InsightPeriod,
  today: string,
): { readonly from: string; readonly to: string } {
  switch (period) {
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
  }
}

/** Every day from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** A report cell as a number: counts arrive as numbers, rates as decimal strings. */
export function num(cell: Cell | undefined): number {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : 0;
  if (typeof cell === 'string') {
    const parsed = cell.trim() === '' ? Number.NaN : Number(cell);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** A rate the API may leave null (nothing to divide by). */
export function rateOf(cell: Cell | undefined): number | null {
  if (cell === null || cell === undefined || cell === '') return null;
  const value = num(cell);
  return Math.max(0, Math.min(100, value));
}

/** `part ÷ whole` as a percentage, or null when there is nothing to divide by. */
export function percent(part: number, whole: number): number | null {
  return whole <= 0 ? null : Math.max(0, Math.min(100, (part / whole) * 100));
}

/** A percentage for display: whole numbers, one decimal under 10. */
export function formatPercent(value: number | null, locale: string): string {
  if (value === null) return '—';
  const digits = value > 0 && value < 10 && !Number.isInteger(value) ? 1 : 0;
  return `${new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(value)}%`;
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US').format(value);
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export interface AttendanceDay {
  readonly period: string;
  readonly present: number;
  readonly late: number;
  readonly wfh: number;
  readonly absent: number;
  readonly leave: number;
}

/**
 * The daily attendance trend, one entry per day of the range up to today —
 * a day with no records is a zero column rather than a gap, so the axis keeps
 * its rhythm. A monthly trend (ranges over 92 days) is returned as sent.
 */
export function attendanceTrend(payload: ReportPayload, today: string): AttendanceDay[] {
  const byPeriod = new Map(payload.trend.map((point) => [point.period, point.values]));
  const day = (period: string): AttendanceDay => {
    const values = byPeriod.get(period) ?? {};
    return {
      period,
      present: num(values.present),
      late: num(values.late),
      wfh: num(values.wfh),
      absent: num(values.absent),
      leave: num(values.leave),
    };
  };
  const range = payload.report.range;
  if (payload.report.trend_unit !== 'day' || range === null) {
    return payload.trend.map((point) => day(point.period));
  }
  const last = range.to < today ? range.to : today;
  return eachDay(range.from, last).map(day);
}

export interface AttendanceTotals {
  readonly employees: number;
  readonly workingDays: number;
  readonly present: number;
  readonly late: number;
  readonly wfh: number;
  readonly absent: number;
  readonly leave: number;
  /** Attended ÷ working days. */
  readonly rate: number | null;
  /** Late ÷ attended. */
  readonly lateRate: number | null;
}

export function attendanceTotals(summary: Readonly<Record<string, Cell>>): AttendanceTotals {
  const workingDays = num(summary.working_days);
  const present = num(summary.present);
  const late = num(summary.late);
  return {
    employees: num(summary.employees),
    workingDays,
    present,
    late,
    wfh: num(summary.wfh),
    absent: num(summary.absent),
    leave: num(summary.leave),
    rate: percent(present, workingDays),
    lateRate: percent(late, present),
  };
}

export interface DepartmentRate {
  readonly id: string;
  readonly name: string | null;
  readonly employees: number;
  readonly rate: number | null;
}

/** Attendance rate per department, best first; departments with no working days last. */
export function departmentAttendance(
  rows: readonly ReportRow[] | undefined,
  locale: string,
): DepartmentRate[] {
  return (rows ?? [])
    .map((row) => ({
      id: (row.department_id as string | null) ?? '',
      name:
        ((locale === 'ar' ? row.department_name_ar : row.department_name_en) as string | null) ??
        null,
      employees: num(row.employees),
      rate: percent(num(row.present), num(row.working_days)),
    }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const TASK_STATUS_ORDER = ['not_started', 'in_progress', 'on_hold', 'completed'] as const;

export interface TaskTotals {
  readonly assigned: number;
  readonly byStatus: Readonly<Record<(typeof TASK_STATUS_ORDER)[number], number>>;
  readonly overdue: number;
  readonly completionRate: number | null;
  readonly onTimeRate: number | null;
}

export function taskTotals(summary: Readonly<Record<string, Cell>>): TaskTotals {
  return {
    assigned: num(summary.assigned),
    byStatus: {
      not_started: num(summary.not_started),
      in_progress: num(summary.in_progress),
      on_hold: num(summary.on_hold),
      completed: num(summary.completed),
    },
    overdue: num(summary.overdue),
    completionRate: rateOf(summary.completion_rate),
    onTimeRate: rateOf(summary.on_time_rate),
  };
}

export const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'] as const;

export interface PriorityLoad {
  readonly priority: string;
  readonly assigned: number;
  readonly completed: number;
}

/** Tasks per priority, most urgent first; priorities with no tasks are dropped. */
export function priorityLoad(rows: readonly ReportRow[] | undefined): PriorityLoad[] {
  const rank = (p: string): number => {
    const index = (PRIORITY_ORDER as readonly string[]).indexOf(p);
    return index === -1 ? PRIORITY_ORDER.length : index;
  };
  return (rows ?? [])
    .map((row) => ({
      priority: (row.priority as string | null) ?? 'medium',
      assigned: num(row.assigned),
      completed: num(row.completed),
    }))
    .filter((row) => row.assigned > 0)
    .sort((a, b) => rank(a.priority) - rank(b.priority));
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalTotals {
  readonly goals: number;
  readonly active: number;
  readonly achieved: number;
  readonly missed: number;
  readonly achievementRate: number | null;
}

export function goalTotals(summary: Readonly<Record<string, Cell>>): GoalTotals {
  return {
    goals: num(summary.goals),
    active: num(summary.active),
    achieved: num(summary.achieved),
    missed: num(summary.missed),
    achievementRate: rateOf(summary.achievement_rate),
  };
}

/** A goal's progress toward its target, 0–100 (over-achievement caps the bar, not the label). */
export function goalProgress(
  current: string | number | null,
  target: string | number | null,
): {
  readonly bar: number;
  readonly value: number | null;
} {
  const value = percent(num(current ?? 0), num(target ?? 0));
  const raw = num(target ?? 0) > 0 ? (num(current ?? 0) / num(target ?? 0)) * 100 : null;
  return { bar: value ?? 0, value: raw === null ? null : Math.max(0, raw) };
}

// ---------------------------------------------------------------------------
// The employee's own month
// ---------------------------------------------------------------------------

export const MY_ATTENDANCE_KEYS = ['present', 'late', 'half_day', 'absent', 'on_leave'] as const;
export type MyAttendanceKey = (typeof MY_ATTENDANCE_KEYS)[number];

/** Counts of the caller's own days by status, from their monthly matrix row. */
export function myAttendanceCounts(
  cells: readonly { readonly status: string | null }[],
): Record<MyAttendanceKey, number> & { readonly workingDays: number } {
  const counts: Record<MyAttendanceKey, number> = {
    present: 0,
    late: 0,
    half_day: 0,
    absent: 0,
    on_leave: 0,
  };
  let workingDays = 0;
  for (const cell of cells) {
    if (cell.status === null || cell.status === 'weekend' || cell.status === 'holiday') continue;
    workingDays += 1;
    // "pending" is a day checked in but not yet out: attended, like the reports count it.
    if (cell.status === 'pending') {
      counts.present += 1;
    } else if ((MY_ATTENDANCE_KEYS as readonly string[]).includes(cell.status)) {
      counts[cell.status as MyAttendanceKey] += 1;
    }
  }
  return { ...counts, workingDays };
}
