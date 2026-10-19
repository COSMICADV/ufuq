/**
 * The performance calculation engine — DOCUMENT 14 "Performance".
 *
 * **The formula is configuration, not code** (DOCUMENT 14 "Critical rule",
 * DOCUMENT 25 Phase 8 exit criterion, DOCUMENT 27 RULE 13). Every weight,
 * penalty and sub-weight arrives in a {@link PerformanceConfig} read from the
 * company's `performance_config` row. This file holds the *shape* of the
 * model DOCUMENT 14 specifies — a rate is a count over a count, expressed as
 * a percentage; a score lives on a 0–100 scale; a weighted average divides by
 * the weights actually used — and no number that a company could want
 * different. `performance-rules.test.ts` checks the source for stray
 * coefficients as well as the behaviour.
 *
 * **Missing components are excluded, never zeroed** (DOCUMENT 14 "Employees
 * with no data"): a component with no data is `null`, and the weights of the
 * components that remain are renormalised so they still sum to one. The same
 * principle applies inside the task score, whose on-time rate does not exist
 * until something has been completed. With nothing left to weigh, the result
 * is `null` — "no data" — not 0%.
 *
 * Pure: counts and configuration in, scores out. Arithmetic is fixed-point
 * (`@ufuq/money`'s `Decimal`) at six places internally and rounded once, at the
 * end, to two (DOCUMENT 27 RULE 17).
 */

import { Decimal } from '@ufuq/money';

import { COMPONENTS, WEIGHT_SCALE } from './performance-config.js';
import type { Component, PerformanceConfig } from './performance-config.js';

/** Internal precision; results are rounded to {@link SCORE_SCALE} once, at the end. */
const WORK_SCALE = 6;
/** Scores and rates are reported to the hundredth, like every percentage. */
export const SCORE_SCALE = 2;

/** A percentage is a ratio times one hundred; the scale runs from nothing to all. */
const PERCENT = 100;
const SCALE_FLOOR = Decimal.zero(WORK_SCALE);
const SCALE_CEILING = Decimal.fromInteger(PERCENT, WORK_SCALE);

/** DOCUMENT 14 "Attendance score" — the counts it is computed from. */
export interface AttendanceInputs {
  /** Scheduled working days in the window (DOCUMENT 14: "against scheduled working days"). */
  readonly workingDays: number;
  readonly presentDays: number;
  readonly wfhDays: number;
  readonly paidLeaveDays: number;
  readonly lateIncidents: number;
  readonly absentDays: number;
}

/** DOCUMENT 14 "Task score" — the counts it is computed from. */
export interface TaskInputs {
  readonly assigned: number;
  readonly completed: number;
  readonly completedOnTime: number;
}

export interface PerformanceInputs {
  /** Null when attendance cannot be evaluated at all (an incomplete schedule). */
  readonly attendance: AttendanceInputs | null;
  readonly task: TaskInputs;
  /** True progress percentages (`"112.00"`) of the goals in the period. */
  readonly goalPercents: readonly string[];
}

export interface PerformanceResult {
  readonly attendance: { readonly score: string | null };
  readonly task: {
    readonly score: string | null;
    readonly completionRate: string | null;
    readonly onTimeRate: string | null;
  };
  readonly goal: { readonly score: string | null };
  readonly overall: string | null;
  /** The weights actually applied, after renormalisation; null for an excluded component. */
  readonly effectiveWeights: Readonly<Record<Component, string | null>>;
}

/**
 * DOCUMENT 14:
 *
 * ```
 * attendance_score = ((present + wfh + paid_leave) ÷ working_days) × 100
 *                    − (late_incidents × late_penalty)
 *                    − (absent_days × absence_penalty)
 * clamped to 0–100
 * ```
 *
 * The attended share is capped at 100% before the penalties are taken, as
 * DOCUMENT 14's own worked example does ("111.5 → clamped 100 → minus late =
 * 98.0"), so surplus days cannot absorb a penalty. No working days means no
 * attendance data — not a perfect or a zero score.
 */
export function attendanceScore(
  inputs: AttendanceInputs,
  config: PerformanceConfig['attendance'],
): Decimal | null {
  assertCounts(inputs);
  if (inputs.workingDays === 0) {
    return null;
  }
  const attended = inputs.presentDays + inputs.wfhDays + inputs.paidLeaveDays;
  const share = clamp(rate(attended, inputs.workingDays));
  const late = config.latePenalty.rescale(WORK_SCALE).multiplyByInteger(inputs.lateIncidents);
  const absent = config.absencePenalty.rescale(WORK_SCALE).multiplyByInteger(inputs.absentDays);
  return clamp(share.subtract(late).subtract(absent));
}

/**
 * DOCUMENT 14:
 *
 * ```
 * completion_rate = completed ÷ assigned × 100
 * on_time_rate    = completed_on_time ÷ completed × 100
 * task_score      = (completion_rate × completion_weight) + (on_time_rate × on_time_weight)
 * ```
 *
 * No assigned tasks means no task score (DOCUMENT 14's own example of a
 * missing component). Nothing completed yet means the on-time rate does not
 * exist; it is excluded and the completion rate carries the score.
 */
export function taskScore(
  inputs: TaskInputs,
  config: PerformanceConfig['task'],
): {
  readonly score: Decimal | null;
  readonly completionRate: Decimal | null;
  readonly onTimeRate: Decimal | null;
} {
  assertCounts(inputs);
  if (inputs.completed > inputs.assigned || inputs.completedOnTime > inputs.completed) {
    throw new RangeError('Task counts are inconsistent');
  }
  if (inputs.assigned === 0) {
    return { score: null, completionRate: null, onTimeRate: null };
  }
  const completionRate = rate(inputs.completed, inputs.assigned);
  const onTimeRate = inputs.completed === 0 ? null : rate(inputs.completedOnTime, inputs.completed);
  const score = weightedAverage([
    { value: completionRate, weight: config.completionWeight },
    { value: onTimeRate, weight: config.onTimeWeight },
  ]);
  return { score, completionRate, onTimeRate };
}

/**
 * DOCUMENT 14: "average of the employee's active goal progress values for the
 * period, each capped at 100 for scoring purposes". No goals, no goal score.
 */
export function goalScore(percents: readonly string[]): Decimal | null {
  if (percents.length === 0) {
    return null;
  }
  const capped = percents.map((percent) => {
    const value = Decimal.parse(percent, SCORE_SCALE).rescale(WORK_SCALE);
    return value.compare(SCALE_CEILING) > 0 ? SCALE_CEILING : value;
  });
  return Decimal.sum(capped, WORK_SCALE).divideByInteger(capped.length, 'nearest');
}

/**
 * DOCUMENT 14:
 *
 * ```
 * overall = (attendance_score × w_attendance)
 *         + (task_score       × w_task)
 *         + (goal_score       × w_goal)
 * ```
 *
 * over the components that have data, divided by the sum of their weights —
 * the renormalisation. Rounded once, here, at the end.
 */
export function computePerformance(
  inputs: PerformanceInputs,
  config: PerformanceConfig,
): PerformanceResult {
  const attendance =
    inputs.attendance === null ? null : attendanceScore(inputs.attendance, config.attendance);
  const task = taskScore(inputs.task, config.task);
  const goal = goalScore(inputs.goalPercents);

  const scores: Readonly<Record<Component, Decimal | null>> = {
    attendance,
    task: task.score,
    goal,
  };
  const overall = weightedAverage(
    COMPONENTS.map((component) => ({
      value: scores[component],
      weight: config.weights[component],
    })),
  );
  const used = Decimal.sum(
    COMPONENTS.filter((component) => scores[component] !== null).map(
      (component) => config.weights[component],
    ),
    WEIGHT_SCALE,
  );
  const effectiveWeights = Object.fromEntries(
    COMPONENTS.map((component) => [
      component,
      scores[component] === null || used.isZero()
        ? null
        : config.weights[component]
            .rescale(WORK_SCALE)
            .divide(used, 'nearest')
            .rescale(WEIGHT_SCALE, 'nearest')
            .toString(),
    ]),
  ) as Record<Component, string | null>;

  return {
    attendance: { score: finish(attendance) },
    task: {
      score: finish(task.score),
      completionRate: finish(task.completionRate),
      onTimeRate: finish(task.onTimeRate),
    },
    goal: { score: finish(goal) },
    overall: finish(overall),
    effectiveWeights,
  };
}

/**
 * `part ÷ whole × 100` as the engine computes a rate — the same precision and
 * the same single rounding — for reports that show a completion or on-time
 * rate beside the scores (Phase 12). Null when there is nothing to divide by.
 */
export function percentRate(part: number, whole: number): string | null {
  assertCounts({ part, whole });
  return whole === 0 ? null : finish(rate(part, whole));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** `part ÷ whole × 100`, at working precision. */
function rate(part: number, whole: number): Decimal {
  return Decimal.fromInteger(part, WORK_SCALE)
    .multiplyByInteger(PERCENT)
    .divideByInteger(whole, 'nearest');
}

function clamp(value: Decimal): Decimal {
  if (value.compare(SCALE_FLOOR) < 0) return SCALE_FLOOR;
  if (value.compare(SCALE_CEILING) > 0) return SCALE_CEILING;
  return value;
}

/**
 * Σ(value × weight) ÷ Σ(weight) over the entries that have a value. Null when
 * none has, or when the weights left are all zero — there is nothing to weigh.
 */
function weightedAverage(
  entries: readonly { readonly value: Decimal | null; readonly weight: Decimal }[],
): Decimal | null {
  const present = entries.filter(
    (entry): entry is { value: Decimal; weight: Decimal } => entry.value !== null,
  );
  const totalWeight = Decimal.sum(
    present.map((entry) => entry.weight.rescale(WORK_SCALE)),
    WORK_SCALE,
  );
  if (present.length === 0 || totalWeight.isZero()) {
    return null;
  }
  const weighted = Decimal.sum(
    present.map((entry) => entry.value.multiply(entry.weight, 'nearest')),
    WORK_SCALE,
  );
  return weighted.divide(totalWeight, 'nearest');
}

function finish(value: Decimal | null): string | null {
  return value === null ? null : value.rescale(SCORE_SCALE, 'nearest').toString();
}

function assertCounts(counts: object): void {
  for (const value of Object.values(counts) as unknown[]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new RangeError('Performance inputs are whole, non-negative counts');
    }
  }
}
