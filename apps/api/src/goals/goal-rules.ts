/**
 * The goal rules that decide numbers and states — DOCUMENT 14 "Business
 * rules" 1, 2, 4, 6, 7 and 8, and the edge cases that change a number.
 *
 * Pure, and the only place each rule is written (DOCUMENT 27 RULES 6 and 7):
 * the services call these and never restate them, and `goal-rules.test.ts`
 * proves them without a database in the way.
 *
 * Nothing here is per type. Progress, milestones and the period-end status
 * read a current value and a target, whatever produced them — so adding a
 * goal type "must not require touching progress calculation for existing
 * types" (DOCUMENT 14 "Types") holds by construction. The one thing that
 * differs by type is *where the current value comes from* (manual entry, or
 * derivation from tasks), and that is `isAutomatic`.
 */

import { Decimal } from '@ufuq/money';

import { TASK_PRIORITIES } from '../tasks/task-rules.js';
import type { TaskPriorityValue } from '../tasks/task-rules.js';

/** DOCUMENT 14 "Types". */
export const GOAL_TYPES = ['sales', 'task', 'custom'] as const;
export type GoalTypeValue = (typeof GOAL_TYPES)[number];

/** DOCUMENT 14 "Statuses". */
export const GOAL_STATUSES = ['active', 'achieved', 'missed', 'cancelled'] as const;
export type GoalStatusValue = (typeof GOAL_STATUSES)[number];

/** DOCUMENT 06 §3.18: `target_value` and `current_value` are DECIMAL(15,2). */
export const VALUE_SCALE = 2;
/** Progress is reported to the hundredth of a percent, like task progress. */
export const PERCENT_SCALE = 2;

/** DOCUMENT 14 rule 6: "Milestones at 25%, 50%, 75%, 100%". */
export const MILESTONES = [25, 50, 75, 100] as const;
export type Milestone = (typeof MILESTONES)[number];

/** A Task goal counts tasks; its unit is not the caller's to choose. */
export const TASK_GOAL_UNIT = 'tasks';

/**
 * DOCUMENT 14 rules 3 and 4: Sales and Custom goals take manual updates; a
 * Task goal's value is derived and "no manual entry" is accepted for it.
 */
export function isAutomatic(type: GoalTypeValue): boolean {
  return type === 'task';
}

// ---------------------------------------------------------------------------
// Rule 1 and 2 — the progress formula and the display cap
// ---------------------------------------------------------------------------

const HUNDREDTHS_PER_WHOLE = 100n;

/**
 * Rule 1: `progress = (current_value ÷ target_value) × 100`, as a decimal
 * string with two places, rounded to the nearest hundredth (half away from
 * zero).
 *
 * This is the **true** value. Over-achievement is kept, not clipped — "112%
 * of target" (rule 2) — so it is computed on the raw minor units rather than
 * through `Decimal`, whose DECIMAL(15,·) precision guard exists for stored
 * money and would refuse a legitimately large percentage of a tiny target.
 * No value passes through a binary float (DOCUMENT 27 RULE 17).
 */
export function progressPercent(current: string, target: string): string {
  const value = Decimal.parse(current, VALUE_SCALE);
  const goal = Decimal.parse(target, VALUE_SCALE);
  if (!goal.isPositive()) {
    // DOCUMENT 14 validation: a zero target is refused before it gets here.
    throw new RangeError('A goal target must be greater than zero');
  }
  if (value.isNegative()) {
    throw new RangeError('A goal value cannot be negative');
  }
  // value.units / goal.units is the ratio (both at scale 2); × 100 for a
  // percentage and × 100 again for hundredths of a percent.
  const numerator = value.units * HUNDREDTHS_PER_WHOLE * HUNDREDTHS_PER_WHOLE;
  const quotient = numerator / goal.units;
  const remainder = numerator % goal.units;
  const hundredths = remainder * 2n >= goal.units ? quotient + 1n : quotient;
  return formatHundredths(hundredths);
}

/** Rule 2: "Display is capped at 100%". The true value is never discarded. */
export function displayPercent(percent: string): string {
  return compareHundredths(percent, '100.00') > 0 ? '100.00' : percent;
}

export function reachesTarget(percent: string): boolean {
  return compareHundredths(percent, '100.00') >= 0;
}

/**
 * Rule 6: the milestones a change crosses on the way up — every one strictly
 * above where the progress was and at or below where it now is. A change
 * that moves progress down crosses none (a reopened task, a corrected
 * figure); moving back up past a milestone crosses it again, because it is
 * a new crossing.
 */
export function milestonesCrossed(before: string | null, after: string): readonly Milestone[] {
  const from = before === null ? 0n : toHundredths(before);
  const to = toHundredths(after);
  return MILESTONES.filter((milestone) => {
    const mark = BigInt(milestone) * HUNDREDTHS_PER_WHOLE;
    return from < mark && mark <= to;
  });
}

/** The milestones a progress value has reached — for the detail screen. */
export function milestonesReached(percent: string): readonly Milestone[] {
  return milestonesCrossed(null, percent);
}

// ---------------------------------------------------------------------------
// Rule 7 — the period end, and DOCUMENT 14 "Employee terminated mid-period"
// ---------------------------------------------------------------------------

/**
 * The day the goal's period effectively ends: its `period_end`, or the
 * owner's termination date when that comes first (DOCUMENT 14 edge case:
 * "Goal is closed at the termination date"). Dates are `YYYY-MM-DD`, so the
 * string comparison is a calendar comparison.
 */
export function closingDate(periodEnd: string, terminationDate: string | null): string {
  return terminationDate !== null && terminationDate < periodEnd ? terminationDate : periodEnd;
}

/**
 * The target a goal is judged against. Normally its target; when the owner is
 * terminated inside the period, the target scaled to the elapsed portion —
 * DOCUMENT 14: "scored against the elapsed portion". Days are counted
 * inclusively at both ends, so a goal closed on its first day is judged
 * against one day's share.
 */
export function effectiveTarget(
  target: string,
  periodStart: string,
  periodEnd: string,
  terminationDate: string | null,
): string {
  if (terminationDate === null || terminationDate >= periodEnd || terminationDate < periodStart) {
    return Decimal.parse(target, VALUE_SCALE).toString();
  }
  const elapsed = inclusiveDays(periodStart, terminationDate);
  const total = inclusiveDays(periodStart, periodEnd);
  const scaled = Decimal.parse(target, VALUE_SCALE)
    .multiplyByInteger(elapsed)
    .divideByInteger(total, 'nearest');
  // Never below one hundredth: a target of zero would divide by zero.
  const floor = Decimal.fromUnits(1n, VALUE_SCALE);
  return (scaled.compare(floor) < 0 ? floor : scaled).toString();
}

/**
 * Rule 7: a goal is `active` until its period has ended; then `achieved` if
 * progress ≥ 100%, otherwise `missed`. Cancellation is final and outranks
 * everything. Because this is a function of the value and the date — not a
 * one-way transition — recalculating or reopening (rule 9) a closed goal
 * re-derives its status: a late sales figure turns `missed` into
 * `achieved`, and extending the period of a closed goal makes it `active`
 * again. History is never deleted either way.
 */
export function deriveStatus(input: {
  readonly status: GoalStatusValue;
  readonly progressPercent: string;
  /** The effective last day — {@link closingDate}. */
  readonly closesOn: string;
  /** The company's calendar day. */
  readonly today: string;
}): GoalStatusValue {
  if (input.status === 'cancelled') {
    return 'cancelled';
  }
  if (input.closesOn >= input.today) {
    return 'active';
  }
  return reachesTarget(input.progressPercent) ? 'achieved' : 'missed';
}

/** Whole days left in an active period, today included as "0 left". */
export function daysRemaining(closesOn: string, today: string): number {
  return closesOn < today ? 0 : inclusiveDays(today, closesOn) - 1;
}

// ---------------------------------------------------------------------------
// Rule 8 — periods
// ---------------------------------------------------------------------------

/** Rule 8: "`period_end` must be after `period_start`" — strictly after. */
export function isValidPeriod(periodStart: string, periodEnd: string): boolean {
  return periodEnd > periodStart;
}

/** Rule 8: "Overlapping goals of the same type … are allowed but warned." */
export function periodsOverlap(
  a: { readonly start: string; readonly end: string },
  b: { readonly start: string; readonly end: string },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

// ---------------------------------------------------------------------------
// Rule 4 — which tasks a Task goal counts
// ---------------------------------------------------------------------------

/**
 * `task_count_rule`, schema version 1 — "which tasks count" (DOCUMENT 04
 * B11, DOCUMENT 05 FLOW 12).
 *
 * DOCUMENT 05 FLOWs 10 and 13 and DOCUMENT 13 rule 8 fix the population: the
 * tasks *linked* to the goal, completed, within the goal's period (DOCUMENT
 * 13: a task completed outside the period "does not contribute"). The rule
 * narrows that population by the one task attribute an administrator can
 * meaningfully choose on: its priority. Every priority counts by default.
 * The version field lets a later rule shape be added without reinterpreting
 * stored rules. See docs/PHASE-8-STATUS.md, "Interpretations".
 */
export const TASK_COUNT_RULE_VERSION = 1;

export interface TaskCountRule {
  readonly version: typeof TASK_COUNT_RULE_VERSION;
  readonly priorities: readonly TaskPriorityValue[];
}

/** Every linked, completed, in-period task counts. */
export const DEFAULT_TASK_COUNT_RULE: TaskCountRule = {
  version: TASK_COUNT_RULE_VERSION,
  priorities: TASK_PRIORITIES,
};

/**
 * A stored or submitted rule, or null when it is not a valid version-1 rule.
 *
 * The approved V1 counting rule: a task counts when it is linked to the goal,
 * belongs to the goal's owner, is completed, and was completed within the
 * goal's period. `priorities` optionally narrows that by priority; when no
 * priority is selected — the key absent or an empty list — every priority
 * counts, and the rule is stored with all four so a stored rule is always
 * explicit.
 *
 * Strict otherwise: unknown keys, an unknown priority or a duplicate are
 * refused rather than ignored. Priorities come back in the canonical order.
 */
export function parseTaskCountRule(value: unknown): TaskCountRule | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'version' && key !== 'priorities')) {
    return null;
  }
  if (record['version'] !== TASK_COUNT_RULE_VERSION) {
    return null;
  }
  const priorities = 'priorities' in record ? record['priorities'] : [];
  if (!Array.isArray(priorities)) {
    return null;
  }
  if (priorities.length === 0) {
    return DEFAULT_TASK_COUNT_RULE;
  }
  const allowed = TASK_PRIORITIES as readonly unknown[];
  if (priorities.some((priority) => !allowed.includes(priority))) {
    return null;
  }
  if (new Set(priorities).size !== priorities.length) {
    return null;
  }
  return {
    version: TASK_COUNT_RULE_VERSION,
    priorities: TASK_PRIORITIES.filter((priority) => priorities.includes(priority)),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function toHundredths(percent: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(percent);
  if (match === null) {
    throw new RangeError(`Not a two-place percentage: ${percent}`);
  }
  return BigInt(match[1] as string) * HUNDREDTHS_PER_WHOLE + BigInt(match[2] as string);
}

function compareHundredths(a: string, b: string): number {
  const left = toHundredths(a);
  const right = toHundredths(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

function formatHundredths(hundredths: bigint): string {
  const whole = hundredths / HUNDREDTHS_PER_WHOLE;
  const fraction = hundredths % HUNDREDTHS_PER_WHOLE;
  return `${whole.toString()}.${fraction.toString().padStart(PERCENT_SCALE, '0')}`;
}

/** Days from `from` to `to`, both included. Dates are `YYYY-MM-DD`. */
function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return (end - start) / 86_400_000 + 1;
}
