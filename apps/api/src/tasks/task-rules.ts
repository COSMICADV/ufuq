/**
 * The task rules that decide numbers and states — DOCUMENT 13 "Business
 * rules" 1, 2, 3, 4 and 5, OD-10.
 *
 * Pure, and the only place each rule is written (DOCUMENT 27 RULES 6 and 7):
 * the service calls these and never restates them, and `task-rules.test.ts`
 * proves them without a database in the way. The DOCUMENT 25 Phase 7 exit
 * criterion — "progress calculation is correct in every checklist scenario,
 * and invalid status transitions are rejected server-side" — is decided here.
 */

import { Decimal } from '@ufuq/money';

/** DOCUMENT 13 "Statuses" — the whole set. There is no `overdue` (rule 1). */
export const TASK_STATUSES = [
  'not_started',
  'in_progress',
  'completed',
  'cancelled',
  'on_hold',
] as const;
export type TaskStatusValue = (typeof TASK_STATUSES)[number];

/** DOCUMENT 13 "Priorities". */
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriorityValue = (typeof TASK_PRIORITIES)[number];

/**
 * DOCUMENT 13 rule 4, verbatim. Anything not listed is refused — including
 * a "transition" to the status the task already has, which DOCUMENT 13
 * validation says is a 422 and not a silent no-op.
 */
export const STATUS_TRANSITIONS: Readonly<Record<TaskStatusValue, readonly TaskStatusValue[]>> = {
  not_started: ['in_progress', 'cancelled', 'on_hold'],
  in_progress: ['completed', 'on_hold', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: ['in_progress'],
  cancelled: [],
};

export function allowedTransitions(from: TaskStatusValue): readonly TaskStatusValue[] {
  return STATUS_TRANSITIONS[from];
}

export function isAllowedTransition(from: TaskStatusValue, to: TaskStatusValue): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Transitions that carry a mandatory reason: cancelling (rule 7) and reopening
 * a completed task (rule 4, "audited, requires reason").
 */
export function transitionRequiresReason(from: TaskStatusValue, to: TaskStatusValue): boolean {
  return to === 'cancelled' || (from === 'completed' && to === 'in_progress');
}

/** Rule 4: `completed → in_progress` is a reopen, audited as `task.reopened`. */
export function isReopen(from: TaskStatusValue, to: TaskStatusValue): boolean {
  return from === 'completed' && to === 'in_progress';
}

/**
 * Rule 5: the first checklist tick or progress note moves a task that has not
 * started into progress. Only `not_started` moves; a task on hold stays on
 * hold, and a finished one stays finished.
 */
export function statusAfterFirstActivity(status: TaskStatusValue): TaskStatusValue {
  return status === 'not_started' ? 'in_progress' : status;
}

/**
 * OD-10, approved default (status-derived, option A): a task with no checklist
 * is 0% before it starts, 50% while in progress and 100% when completed.
 * On hold and cancelled keep the progress the task already had — pausing or
 * cancelling work does not change how much of it was done.
 */
const STATUS_DERIVED_PERCENT: Readonly<Partial<Record<TaskStatusValue, number>>> = {
  not_started: 0,
  in_progress: 50,
  completed: 100,
};

/** DOCUMENT 06 §2: percentages are DECIMAL(5,2). */
export const PERCENT_SCALE = 2;

export interface ProgressInput {
  readonly status: TaskStatusValue;
  readonly totalItems: number;
  readonly completedItems: number;
  /** The stored `progress_percent`, as a DECIMAL(5,2) string. */
  readonly currentPercent: string;
}

/**
 * The task's progress as a DECIMAL(5,2) string.
 *
 * With a checklist — rule 2 — `completed ÷ total × 100`, whatever the status:
 * a checklist added after completion recalculates progress and the task stays
 * completed (DOCUMENT 13 edge cases). Without one — rule 3 and the "all
 * checklist items deleted" edge case — the OD-10 status rule, which never
 * divides by zero.
 *
 * The division is done by `@ufuq/money`'s `Decimal` — the workspace's one
 * decimal implementation (DOCUMENT 27 RULES 6 and 17) — and rounded to the
 * nearest hundredth, half away from zero, so 1 of 3 is exactly "33.33" and
 * 2 of 3 exactly "66.67"; no value passes through a binary float
 * (DOCUMENT 06 §2: percentages are DECIMAL(5,2)).
 */
export function computeProgress(input: ProgressInput): string {
  const { totalItems, completedItems } = input;
  if (!Number.isInteger(totalItems) || !Number.isInteger(completedItems)) {
    throw new RangeError('Checklist counts must be integers');
  }
  if (totalItems < 0 || completedItems < 0 || completedItems > totalItems) {
    throw new RangeError('Completed items must be between 0 and the total');
  }
  if (totalItems > 0) {
    return Decimal.fromInteger(completedItems * 100, PERCENT_SCALE)
      .divideByInteger(totalItems, 'nearest')
      .toString();
  }
  const derived = STATUS_DERIVED_PERCENT[input.status];
  return derived === undefined
    ? Decimal.parse(input.currentPercent, PERCENT_SCALE).toString()
    : Decimal.fromInteger(derived, PERCENT_SCALE).toString();
}

/**
 * Rule 1: `deadline < today AND status ∉ {completed, cancelled}`. Derived on
 * every read, never stored, never settable. Dates are `YYYY-MM-DD` in the
 * company's timezone, so the string comparison is a calendar comparison.
 */
export function isOverdue(
  task: { readonly deadline: string | null; readonly status: TaskStatusValue },
  today: string,
): boolean {
  return (
    task.deadline !== null &&
    task.deadline < today &&
    task.status !== 'completed' &&
    task.status !== 'cancelled'
  );
}

/** The statuses an overdue task can have — the query form of rule 1. */
export const OPEN_STATUSES: readonly TaskStatusValue[] = ['not_started', 'in_progress', 'on_hold'];
