/**
 * The goal screens' pure half — DOCUMENT 14, DOCUMENT 04 B11–B12 / C7.
 *
 * Kept free of React so the presentation rules that are easy to get subtly
 * wrong — the capped bar beside the true figure, a percentage-unit goal's two
 * numbers, which filters survive in the URL, the chart's scale — are tested
 * directly (`goals.test.ts`).
 *
 * Nothing here decides anything the server decides. Progress, status,
 * milestones and what may be edited are the API's
 * (`apps/api/src/goals/goal-rules.ts`); the screens render what it returns.
 */

import type { PersonRef, TaskPriority, TaskStatus } from './tasks';
import { TASK_PRIORITIES, formatPercent } from './tasks';

export const GOAL_TYPES = ['sales', 'task', 'custom'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_STATUSES = ['active', 'achieved', 'missed', 'cancelled'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface TaskCountRule {
  readonly version: number;
  readonly priorities: readonly TaskPriority[];
}

/** `GET /goals` item — see `apps/api/src/goals/goal-payload.ts`. */
export interface Goal {
  readonly id: string;
  readonly type: GoalType;
  readonly title: string;
  readonly description: string | null;
  readonly employee: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly status: string;
  };
  readonly target_value: string;
  readonly current_value: string;
  readonly unit: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly status: GoalStatus;
  readonly task_count_rule: TaskCountRule | null;
  readonly is_automatic: boolean;
  /** The true progress — over 100 when over-achieved. */
  readonly progress_percent: string;
  /** The same, capped at 100 for a bar. */
  readonly progress_display_percent: string;
  readonly effective_target_value: string;
  readonly closes_on: string;
  readonly days_remaining: number | null;
  readonly created_by: PersonRef;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LinkedTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly deadline: string | null;
  readonly completed_at: string | null;
  readonly counts: boolean;
}

/** `GET /goals/{id}`. */
export interface GoalDetail extends Goal {
  readonly milestones_reached: readonly number[];
  readonly linked_tasks: readonly LinkedTask[];
  readonly possibly_misconfigured: boolean;
  readonly abilities: {
    readonly can_edit: boolean;
    readonly can_update_progress: boolean;
    readonly can_cancel: boolean;
  };
}

/** `POST /goals` and `PATCH /goals/{id}`. */
export interface GoalWriteResult extends GoalDetail {
  readonly warnings: readonly string[];
}

/** `POST /goals/{id}/progress`. */
export interface GoalProgressResult extends GoalDetail {
  readonly milestones_crossed: readonly number[];
}

/** `GET /goals/{id}/progress` item. */
export interface GoalHistoryRow {
  readonly id: string;
  readonly goal_id: string;
  readonly value: string;
  readonly previous_value: string | null;
  readonly target_value: string;
  readonly progress_percent: string;
  readonly note: string | null;
  readonly source: 'manual' | 'system';
  readonly author: PersonRef;
  readonly created_at: string;
}

/** Mirrored for `maxLength` and inline hints only; the API validates. */
export const GOAL_TITLE_MAX_LENGTH = 255;
export const GOAL_DESCRIPTION_MAX_LENGTH = 5000;
export const GOAL_UNIT_MAX_LENGTH = 20;
export const GOAL_NOTE_MAX_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function goalTypeKey(type: GoalType): string {
  return `goals.type.${type}`;
}

export function goalStatusKey(status: GoalStatus): string {
  return `goals.status.${status}`;
}

/** Status → an existing design-system tone (DOCUMENT 27 RULE 22: no new colours). */
export const GOAL_STATUS_TONE: Readonly<
  Record<GoalStatus, 'info' | 'success' | 'danger' | 'cancelled'>
> = {
  active: 'info',
  achieved: 'success',
  missed: 'danger',
  cancelled: 'cancelled',
};

export function ownerName(goal: Pick<Goal, 'employee'>): string {
  return `${goal.employee.first_name} ${goal.employee.last_name}`.trim();
}

/** `"75000.00"` → `"75000"`, `"84.50"` → `"84.5"`: the digits a person reads. */
export function formatValue(value: string): string {
  return formatPercent(value);
}

/**
 * A value with its unit. A percentage unit reads as `84%`; any other unit
 * follows the figure (`75000 EGP`, `15 tasks` — the task unit is translated by
 * the caller, since `tasks` is a stored code, not a word).
 */
export function valueWithUnit(value: string, unit: string): string {
  const figure = formatValue(value);
  return unit === '%' ? `${figure}%` : `${figure} ${unit}`;
}

/**
 * DOCUMENT 14 rule 2 and the Custom example: the bar is capped, the true value
 * is shown as text, and a goal whose unit is itself a percentage shows both
 * numbers without confusing them — "84% (93.3% of target)". Returns the
 * parts; the screen supplies the words.
 */
export function progressParts(goal: Pick<Goal, 'progress_percent' | 'progress_display_percent'>): {
  /** 0–100, for the bar. */
  readonly bar: string;
  /** The true figure, possibly above 100. */
  readonly truth: string;
  readonly overAchieved: boolean;
} {
  return {
    bar: goal.progress_display_percent,
    truth: formatPercent(goal.progress_percent),
    overAchieved: Number(goal.progress_percent) > 100,
  };
}

export function goalsPath(locale: string, surface: 'admin' | 'app' = 'admin'): string {
  return `/${locale}/${surface}/goals`;
}

export function goalPath(locale: string, id: string, surface: 'admin' | 'app' = 'admin'): string {
  return `/${locale}/${surface}/goals/${id}`;
}

/** `/admin/goals/new`, optionally with the owner chosen (profile "Assign goal"). */
export function newGoalPath(locale: string, employeeId?: string): string {
  const base = `/${locale}/admin/goals/new`;
  return employeeId === undefined ? base : `${base}?employee=${encodeURIComponent(employeeId)}`;
}

// ---------------------------------------------------------------------------
// The progress chart — DOCUMENT 04 B12 "progress chart over the period"
// ---------------------------------------------------------------------------

export interface ChartPoint {
  /** 0–1 across the chart, by the order the history was written. */
  readonly x: number;
  /** 0–1 up the chart. */
  readonly y: number;
  readonly percent: string;
}

/**
 * History rows (newest first, as the API returns them) as points, oldest
 * first. Each point is that row's own progress — its value against the
 * target *it* recorded — so a mid-period target change does not redraw the
 * past (DOCUMENT 14 "Target changed mid-period"). The vertical scale reaches
 * 100% at least, and further when the goal was over-achieved, so the 100%
 * line is always on the chart.
 */
export function chartPoints(rows: readonly GoalHistoryRow[]): {
  readonly points: readonly ChartPoint[];
  readonly ceiling: number;
} {
  const ordered = [...rows].reverse();
  const ceiling = Math.max(100, ...ordered.map((row) => Number(row.progress_percent)));
  const span = Math.max(1, ordered.length - 1);
  return {
    ceiling,
    points: ordered.map((row, index) => ({
      x: ordered.length === 1 ? 0.5 : index / span,
      y: Number(row.progress_percent) / ceiling,
      percent: row.progress_percent,
    })),
  };
}

// ---------------------------------------------------------------------------
// The create / edit form — DOCUMENT 04 B11, DOCUMENT 05 FLOW 12
// ---------------------------------------------------------------------------

export interface GoalForm {
  type: GoalType;
  employee_id: string;
  title: string;
  description: string;
  target_value: string;
  unit: string;
  period_start: string;
  period_end: string;
  priorities: TaskPriority[];
}

export const EMPTY_GOAL_FORM: GoalForm = {
  type: 'sales',
  employee_id: '',
  title: '',
  description: '',
  target_value: '',
  unit: '',
  period_start: '',
  period_end: '',
  priorities: [...TASK_PRIORITIES],
};

export function formFromGoal(goal: Goal): GoalForm {
  return {
    type: goal.type,
    employee_id: goal.employee.id,
    title: goal.title,
    description: goal.description ?? '',
    target_value: formatValue(goal.target_value),
    unit: goal.unit,
    period_start: goal.period_start,
    period_end: goal.period_end,
    priorities: [...(goal.task_count_rule?.priorities ?? TASK_PRIORITIES)],
  };
}

/**
 * The priorities a Task goal counts, in canonical order. The approved V1 rule:
 * with none selected, every priority counts — so the form never blocks on an
 * empty selection, and it sends the explicit list the API stores.
 */
export function countedPriorities(selected: readonly TaskPriority[]): TaskPriority[] {
  return selected.length === 0
    ? [...TASK_PRIORITIES]
    : TASK_PRIORITIES.filter((priority) => selected.includes(priority));
}

/**
 * The `POST /goals` body. Only the fields a type takes are sent: a Sales
 * goal's unit is the company currency (the API fills it in), a Task goal's is
 * `tasks`, and only a Task goal has a counting rule.
 */
export function createBody(form: GoalForm): Record<string, unknown> {
  return {
    employee_id: form.employee_id,
    type: form.type,
    title: form.title,
    description: form.description === '' ? null : form.description,
    target_value: form.target_value.trim(),
    period_start: form.period_start,
    period_end: form.period_end,
    ...(form.type === 'custom' ? { unit: form.unit } : {}),
    ...(form.type === 'task'
      ? { task_count_rule: { version: 1, priorities: countedPriorities(form.priorities) } }
      : {}),
  };
}

/** The `PATCH /goals/{id}` body — only what changed, so the audit names only that. */
export function updateBody(goal: Goal, form: GoalForm): Record<string, unknown> {
  const before = formFromGoal(goal);
  const body: Record<string, unknown> = {};
  if (form.title !== before.title) body['title'] = form.title;
  if (form.description !== before.description) {
    body['description'] = form.description === '' ? null : form.description;
  }
  if (form.target_value.trim() !== before.target_value)
    body['target_value'] = form.target_value.trim();
  if (goal.type === 'custom' && form.unit !== before.unit) body['unit'] = form.unit;
  if (form.period_start !== before.period_start) body['period_start'] = form.period_start;
  if (form.period_end !== before.period_end) body['period_end'] = form.period_end;
  const priorities = countedPriorities(form.priorities);
  if (goal.type === 'task' && priorities.join() !== countedPriorities(before.priorities).join()) {
    body['task_count_rule'] = { version: 1, priorities };
  }
  return body;
}

/** DOCUMENT 14 rule 8, as a hint before submitting. The API decides. */
export function periodIsValid(start: string, end: string): boolean {
  return start === '' || end === '' || end > start;
}

// ---------------------------------------------------------------------------
// Admin list filters — held in the URL (DOCUMENT 11 §6)
// ---------------------------------------------------------------------------

export interface GoalFilters {
  readonly type: string;
  readonly status: string;
  readonly page: number;
}

export const EMPTY_GOAL_FILTERS: GoalFilters = { type: '', status: '', page: 1 };

export function goalFiltersFromParams(params: URLSearchParams): GoalFilters {
  const read = (key: string): string => params.get(key)?.trim() ?? '';
  const page = Number(read('page'));
  return {
    type: (GOAL_TYPES as readonly string[]).includes(read('type')) ? read('type') : '',
    status: (GOAL_STATUSES as readonly string[]).includes(read('status')) ? read('status') : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function searchForGoalFilters(filters: GoalFilters): string {
  const params = new URLSearchParams();
  if (filters.type !== '') params.set('type', filters.type);
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.page > 1) params.set('page', String(filters.page));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function apiQueryForGoalFilters(
  filters: GoalFilters,
  perPage: number,
): Record<string, string> {
  return {
    page: String(filters.page),
    per_page: String(perPage),
    ...(filters.type === '' ? {} : { type: filters.type }),
    ...(filters.status === '' ? {} : { status: filters.status }),
  };
}
