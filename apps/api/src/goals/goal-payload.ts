/**
 * Goal rows → the DOCUMENT 08 §1 wire shape (snake_case).
 *
 * Derived on every read rather than stored (DOCUMENT 06 §3.18: "progress is
 * computed"):
 *
 *   - `progress_percent` — DOCUMENT 14 rule 1, the **true** value, so
 *     over-achievement stays visible ("112% of target", rule 2);
 *   - `progress_display_percent` — the same capped at 100 for a bar;
 *   - `closes_on`, `effective_target_value` — the termination edge case;
 *   - `days_remaining` — DOCUMENT 14 "Mobile behaviour".
 *
 * Values are DECIMAL(15,2) strings ("75000.00"), the same way money and
 * percentages travel everywhere else (DOCUMENT 08 §1).
 */

import type { Prisma } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { dateToWire } from '../attendance/attendance-payload.js';
import { personRef } from '../tasks/task-payload.js';
import type { PersonRef } from '../tasks/task-payload.js';
import type { TaskPriorityValue, TaskStatusValue } from '../tasks/task-rules.js';

import {
  closingDate,
  daysRemaining,
  displayPercent,
  effectiveTarget,
  isAutomatic,
  milestonesReached,
  parseTaskCountRule,
  progressPercent,
  VALUE_SCALE,
} from './goal-rules.js';
import type { GoalStatusValue, GoalTypeValue, Milestone, TaskCountRule } from './goal-rules.js';

const PERSON_SELECT = {
  id: true,
  email: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

export const GOAL_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      status: true,
      managerId: true,
      terminationDate: true,
    },
  },
  createdByUser: { select: PERSON_SELECT },
} as const satisfies Prisma.GoalInclude;

export type GoalRow = Prisma.GoalGetPayload<{ include: typeof GOAL_INCLUDE }>;

export const GOAL_PROGRESS_INCLUDE = {
  createdByUser: { select: PERSON_SELECT },
} as const satisfies Prisma.GoalProgressInclude;

export type GoalProgressRow = Prisma.GoalProgressGetPayload<{
  include: typeof GOAL_PROGRESS_INCLUDE;
}>;

export interface GoalPayload {
  readonly id: string;
  readonly type: GoalTypeValue;
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
  readonly status: GoalStatusValue;
  readonly task_count_rule: TaskCountRule | null;
  /** DOCUMENT 14 rules 3–4: whether the value is derived (Task) or entered (Sales, Custom). */
  readonly is_automatic: boolean;
  readonly progress_percent: string;
  readonly progress_display_percent: string;
  /** The target the goal is judged against — its target, unless the owner left mid-period. */
  readonly effective_target_value: string;
  /** The effective last day of the period. */
  readonly closes_on: string;
  /** Null once the goal is no longer active. */
  readonly days_remaining: number | null;
  readonly created_by: PersonRef;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface LinkedTaskPayload {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatusValue;
  readonly priority: TaskPriorityValue;
  readonly deadline: string | null;
  readonly completed_at: string | null;
  /** Whether this task contributes to the goal's value (Task goals only). */
  readonly counts: boolean;
}

/** `GET /goals/{id}` — the goal with what DOCUMENT 04 B12 / C7 show beside it. */
export interface GoalDetailPayload extends GoalPayload {
  readonly milestones_reached: readonly Milestone[];
  /** DOCUMENT 04 B12 "linked tasks", C7 "the contributing tasks". */
  readonly linked_tasks: readonly LinkedTaskPayload[];
  /**
   * DOCUMENT 14 edge case "Task goal with zero qualifying tasks": flagged in
   * the admin view as possibly misconfigured.
   */
  readonly possibly_misconfigured: boolean;
  /** The server's own answers, so a screen offers only what the API accepts. */
  readonly abilities: {
    readonly can_edit: boolean;
    readonly can_update_progress: boolean;
    readonly can_cancel: boolean;
  };
}

export interface GoalProgressPayload {
  readonly id: string;
  readonly goal_id: string;
  readonly value: string;
  readonly previous_value: string | null;
  /** The target in effect when this row was written (DOCUMENT 14 "Target changed mid-period"). */
  readonly target_value: string;
  readonly progress_percent: string;
  readonly note: string | null;
  readonly source: 'manual' | 'system';
  readonly author: PersonRef;
  readonly created_at: string;
}

/** DECIMAL(15,2) as its two-decimal string ("75000.00"). */
export function valueToWire(value: Prisma.Decimal): string {
  return Decimal.parse(value.toString(), VALUE_SCALE).toString();
}

/** The numbers a goal is judged by: its progress, its effective target and its last day. */
export function goalMeasures(
  row: Pick<GoalRow, 'targetValue' | 'currentValue' | 'periodStart' | 'periodEnd'> & {
    readonly employee: { readonly terminationDate: Date | null };
  },
): {
  readonly progressPercent: string;
  readonly effectiveTarget: string;
  readonly closesOn: string;
} {
  const periodStart = dateToWire(row.periodStart);
  const periodEnd = dateToWire(row.periodEnd);
  const termination =
    row.employee.terminationDate === null ? null : dateToWire(row.employee.terminationDate);
  const target = effectiveTarget(valueToWire(row.targetValue), periodStart, periodEnd, termination);
  return {
    progressPercent: progressPercent(valueToWire(row.currentValue), target),
    effectiveTarget: target,
    closesOn: closingDate(periodEnd, termination),
  };
}

export function goalPayload(row: GoalRow, today: string): GoalPayload {
  const measures = goalMeasures(row);
  const status = row.status as GoalStatusValue;
  return {
    id: row.id,
    type: row.type as GoalTypeValue,
    title: row.title,
    description: row.description,
    employee: {
      id: row.employee.id,
      employee_code: row.employee.employeeCode,
      first_name: row.employee.firstName,
      last_name: row.employee.lastName,
      status: row.employee.status,
    },
    target_value: valueToWire(row.targetValue),
    current_value: valueToWire(row.currentValue),
    unit: row.unit,
    period_start: dateToWire(row.periodStart),
    period_end: dateToWire(row.periodEnd),
    status,
    task_count_rule: row.taskCountRule === null ? null : parseTaskCountRule(row.taskCountRule),
    is_automatic: isAutomatic(row.type as GoalTypeValue),
    progress_percent: measures.progressPercent,
    progress_display_percent: displayPercent(measures.progressPercent),
    effective_target_value: measures.effectiveTarget,
    closes_on: measures.closesOn,
    days_remaining: status === 'active' ? daysRemaining(measures.closesOn, today) : null,
    created_by: personRef(row.createdByUser),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function goalDetailPayload(
  row: GoalRow,
  today: string,
  extra: Omit<GoalDetailPayload, keyof GoalPayload | 'milestones_reached'>,
): GoalDetailPayload {
  const base = goalPayload(row, today);
  return {
    ...base,
    milestones_reached: milestonesReached(base.progress_percent),
    ...extra,
  };
}

export function goalProgressPayload(row: GoalProgressRow): GoalProgressPayload {
  const value = valueToWire(row.value);
  const target = valueToWire(row.targetValue);
  return {
    id: row.id,
    goal_id: row.goalId,
    value,
    previous_value: row.previousValue === null ? null : valueToWire(row.previousValue),
    target_value: target,
    progress_percent: progressPercent(value, target),
    note: row.note,
    source: row.source,
    author: personRef(row.createdByUser),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The fields an audit record of a goal edit may name — DOCUMENT 21 "only the
 * fields that changed". Diffed with `diffSnapshots` (DOCUMENT 27 RULE 6).
 */
export type GoalAuditSnapshot = Readonly<Record<string, string | null>>;

export function goalAuditSnapshot(row: {
  readonly employeeId: string;
  readonly type: string;
  readonly title: string;
  readonly description: string | null;
  readonly targetValue: Prisma.Decimal;
  readonly currentValue: Prisma.Decimal;
  readonly unit: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: string;
  readonly taskCountRule: Prisma.JsonValue;
}): GoalAuditSnapshot {
  return {
    employee_id: row.employeeId,
    type: row.type,
    title: row.title,
    description: row.description,
    target_value: valueToWire(row.targetValue),
    current_value: valueToWire(row.currentValue),
    unit: row.unit,
    period_start: dateToWire(row.periodStart),
    period_end: dateToWire(row.periodEnd),
    status: row.status,
    task_count_rule: row.taskCountRule === null ? null : JSON.stringify(row.taskCountRule),
  };
}
