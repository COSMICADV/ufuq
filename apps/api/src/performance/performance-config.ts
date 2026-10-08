/**
 * The performance model, as configuration — DOCUMENT 14 "Performance",
 * "Validation" and "Database requirements".
 *
 * `performance_config.config` is structured JSON with a schema version. This
 * file is the one definition of what a version-1 document is, used both to
 * validate a save (`PATCH /performance-config`) and to read the stored row
 * before the engine runs, so the engine never meets a shape it was not
 * written for.
 *
 * There are no default numbers here. DOCUMENT 14's default model is written by
 * the database when a company is created (migration
 * `20261006000000_phase8_goals_performance`) and is from then on simply that
 * company's configuration.
 */

import { normaliseDigits } from '@ufuq/i18n';
import { Decimal, DecimalError, RATE_SCALE } from '@ufuq/money';

/** The schema version this code reads and writes. */
export const PERFORMANCE_CONFIG_VERSION = 1;

/** Weights are fractions of one, to four places (`@ufuq/money`'s rate scale). */
export const WEIGHT_SCALE = RATE_SCALE;
/** Penalties are points of a 0–100 score, to two places. */
export const PENALTY_SCALE = 2;

/** The three components DOCUMENT 14's overall score combines. */
export const COMPONENTS = ['attendance', 'task', 'goal'] as const;
export type Component = (typeof COMPONENTS)[number];

export interface PerformanceConfig {
  readonly schemaVersion: typeof PERFORMANCE_CONFIG_VERSION;
  /** `w_attendance`, `w_task`, `w_goal`. */
  readonly weights: Readonly<Record<Component, Decimal>>;
  readonly attendance: {
    readonly latePenalty: Decimal;
    readonly absencePenalty: Decimal;
  };
  readonly task: {
    readonly completionWeight: Decimal;
    readonly onTimeWeight: Decimal;
  };
}

/** The wire and storage shape — snake_case, decimals as strings (DOCUMENT 08 §1). */
export interface PerformanceConfigJson {
  readonly weights: Readonly<Record<Component, string>>;
  readonly attendance: { readonly late_penalty: string; readonly absence_penalty: string };
  readonly task: { readonly completion_weight: string; readonly on_time_weight: string };
}

export type ConfigIssue = 'required' | 'invalid' | 'must_sum_to_one';

export type ConfigResult =
  | { readonly ok: true; readonly config: PerformanceConfig }
  | { readonly ok: false; readonly fields: Readonly<Record<string, readonly ConfigIssue[]>> };

const ZERO_WEIGHT = Decimal.zero(WEIGHT_SCALE);
const WHOLE_WEIGHT = Decimal.fromInteger(1, WEIGHT_SCALE);
const ZERO_POINTS = Decimal.zero(PENALTY_SCALE);
/** A penalty is points off a score that cannot exceed the top of its scale. */
const MAX_POINTS = Decimal.fromInteger(100, PENALTY_SCALE);

/**
 * Validate a configuration document — DOCUMENT 14 "Validation": "Performance
 * weights must each be 0–1 and sum to exactly 1.0". The same holds for the
 * task score's two sub-weights, which are a weighted average of their own.
 * Penalties are non-negative points, at most a whole score.
 *
 * Every problem is reported at once, keyed by the field's path, so a settings
 * screen can mark all of them; a sum that is not one is reported against the
 * group with `must_sum_to_one`, which the screen shows beside the live sum.
 */
export function parsePerformanceConfig(input: unknown): ConfigResult {
  const fields: Record<string, ConfigIssue[]> = {};
  const add = (path: string, issue: ConfigIssue): void => {
    (fields[path] ??= []).push(issue);
  };

  const root = asObject(input);
  if (root === null) {
    return { ok: false, fields: { config: ['invalid'] } };
  }
  rejectUnknownKeys(root, ['weights', 'attendance', 'task'], '', add);

  const weightsInput = groupOf(root, 'weights', add);
  const weights = {} as Record<Component, Decimal>;
  for (const component of COMPONENTS) {
    const value = readDecimal(weightsInput, `weights.${component}`, component, WEIGHT_SCALE, add);
    if (value !== null) {
      if (value.compare(ZERO_WEIGHT) < 0 || value.compare(WHOLE_WEIGHT) > 0) {
        add(`weights.${component}`, 'invalid');
      } else {
        weights[component] = value;
      }
    }
  }
  if (weightsInput !== null) {
    rejectUnknownKeys(weightsInput, COMPONENTS, 'weights.', add);
  }
  if (COMPONENTS.every((component) => weights[component] !== undefined)) {
    const sum = Decimal.sum(
      COMPONENTS.map((component) => weights[component]),
      WEIGHT_SCALE,
    );
    if (!sum.equals(WHOLE_WEIGHT)) {
      add('weights', 'must_sum_to_one');
    }
  }

  const attendanceInput = groupOf(root, 'attendance', add);
  const latePenalty = readPenalty(attendanceInput, 'attendance.late_penalty', 'late_penalty', add);
  const absencePenalty = readPenalty(
    attendanceInput,
    'attendance.absence_penalty',
    'absence_penalty',
    add,
  );
  if (attendanceInput !== null) {
    rejectUnknownKeys(attendanceInput, ['late_penalty', 'absence_penalty'], 'attendance.', add);
  }

  const taskInput = groupOf(root, 'task', add);
  const completionWeight = readSubWeight(
    taskInput,
    'task.completion_weight',
    'completion_weight',
    add,
  );
  const onTimeWeight = readSubWeight(taskInput, 'task.on_time_weight', 'on_time_weight', add);
  if (taskInput !== null) {
    rejectUnknownKeys(taskInput, ['completion_weight', 'on_time_weight'], 'task.', add);
  }
  if (completionWeight !== null && onTimeWeight !== null) {
    if (!completionWeight.add(onTimeWeight).equals(WHOLE_WEIGHT)) {
      add('task', 'must_sum_to_one');
    }
  }

  if (
    Object.keys(fields).length > 0 ||
    latePenalty === null ||
    absencePenalty === null ||
    completionWeight === null ||
    onTimeWeight === null
  ) {
    return { ok: false, fields };
  }
  return {
    ok: true,
    config: {
      schemaVersion: PERFORMANCE_CONFIG_VERSION,
      weights,
      attendance: { latePenalty, absencePenalty },
      task: { completionWeight, onTimeWeight },
    },
  };
}

/** The canonical JSON form — every value at its fixed scale, so `"0.3"` is stored as `"0.3000"`. */
export function performanceConfigToJson(config: PerformanceConfig): PerformanceConfigJson {
  return {
    weights: {
      attendance: config.weights.attendance.toString(),
      task: config.weights.task.toString(),
      goal: config.weights.goal.toString(),
    },
    attendance: {
      late_penalty: config.attendance.latePenalty.toString(),
      absence_penalty: config.attendance.absencePenalty.toString(),
    },
    task: {
      completion_weight: config.task.completionWeight.toString(),
      on_time_weight: config.task.onTimeWeight.toString(),
    },
  };
}

/** The same document flattened to `path → value`, for the audit diff. */
export function flattenConfig(json: PerformanceConfigJson): Readonly<Record<string, string>> {
  return {
    'weights.attendance': json.weights.attendance,
    'weights.task': json.weights.task,
    'weights.goal': json.weights.goal,
    'attendance.late_penalty': json.attendance.late_penalty,
    'attendance.absence_penalty': json.attendance.absence_penalty,
    'task.completion_weight': json.task.completion_weight,
    'task.on_time_weight': json.task.on_time_weight,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Add = (path: string, issue: ConfigIssue) => void;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function groupOf(
  root: Record<string, unknown>,
  key: string,
  add: Add,
): Record<string, unknown> | null {
  if (!(key in root)) {
    add(key, 'required');
    return null;
  }
  const group = asObject(root[key]);
  if (group === null) {
    add(key, 'invalid');
  }
  return group;
}

function rejectUnknownKeys(
  group: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  add: Add,
): void {
  for (const key of Object.keys(group)) {
    if (!allowed.includes(key)) {
      add(`${prefix}${key}`, 'invalid');
    }
  }
}

/**
 * A decimal from a string — never from a JSON number, which has already lost
 * precision before this code could see it (DOCUMENT 27 RULE 17). Arabic-Indic
 * digits are normalised first (DOCUMENT 08 §5.5).
 */
function readDecimal(
  group: Record<string, unknown> | null,
  path: string,
  key: string,
  scale: number,
  add: Add,
): Decimal | null {
  if (group === null) {
    return null;
  }
  const raw = group[key];
  if (raw === undefined || raw === null || raw === '') {
    add(path, 'required');
    return null;
  }
  if (typeof raw !== 'string') {
    add(path, 'invalid');
    return null;
  }
  try {
    return Decimal.parse(normaliseDigits(raw.trim()), scale);
  } catch (error) {
    if (error instanceof DecimalError) {
      add(path, 'invalid');
      return null;
    }
    throw error;
  }
}

function readPenalty(
  group: Record<string, unknown> | null,
  path: string,
  key: string,
  add: Add,
): Decimal | null {
  const value = readDecimal(group, path, key, PENALTY_SCALE, add);
  if (value === null) {
    return null;
  }
  if (value.compare(ZERO_POINTS) < 0 || value.compare(MAX_POINTS) > 0) {
    add(path, 'invalid');
    return null;
  }
  return value;
}

function readSubWeight(
  group: Record<string, unknown> | null,
  path: string,
  key: string,
  add: Add,
): Decimal | null {
  const value = readDecimal(group, path, key, WEIGHT_SCALE, add);
  if (value === null) {
    return null;
  }
  if (value.compare(ZERO_WEIGHT) < 0 || value.compare(WHOLE_WEIGHT) > 0) {
    add(path, 'invalid');
    return null;
  }
  return value;
}
