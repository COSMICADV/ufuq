/**
 * DOCUMENT 14 "Performance", proved without a database — DOCUMENT 26 §2
 * "Performance score: every weight configuration; missing components
 * renormalised, not zeroed".
 *
 * DOCUMENT 25 Phase 8 exit criterion: "performance scores are computed
 * entirely from configuration, with no weight or coefficient present in
 * code". Both halves are checked here: the behaviour (change the
 * configuration and the score follows it exactly) and the source (the engine
 * contains none of DOCUMENT 14's default numbers, nor any decimal literal).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  flattenConfig,
  parsePerformanceConfig,
  performanceConfigToJson,
} from './performance-config.js';
import type { PerformanceConfig } from './performance-config.js';
import { attendanceScore, computePerformance, goalScore, taskScore } from './performance-rules.js';
import type { AttendanceInputs, PerformanceInputs } from './performance-rules.js';

/** DOCUMENT 14's default model, written here only as test data. */
const DEFAULT_JSON = {
  weights: { attendance: '0.30', task: '0.40', goal: '0.30' },
  attendance: { late_penalty: '1.0', absence_penalty: '5.0' },
  task: { completion_weight: '0.6', on_time_weight: '0.4' },
};

function config(json: unknown = DEFAULT_JSON): PerformanceConfig {
  const result = parsePerformanceConfig(json);
  if (!result.ok) {
    throw new Error(`invalid test config: ${JSON.stringify(result.fields)}`);
  }
  return result.config;
}

function withWeights(attendance: string, task: string, goal: string): PerformanceConfig {
  return config({ ...DEFAULT_JSON, weights: { attendance, task, goal } });
}

const AHMED_SEPTEMBER: AttendanceInputs = {
  workingDays: 26,
  presentDays: 22,
  wfhDays: 7,
  paidLeaveDays: 0,
  lateIncidents: 2,
  absentDays: 0,
};

describe('configuration validation — DOCUMENT 14 "Validation"', () => {
  it('accepts the documented default and stores it at fixed scale', () => {
    const json = performanceConfigToJson(config());
    expect(json).toEqual({
      weights: { attendance: '0.3000', task: '0.4000', goal: '0.3000' },
      attendance: { late_penalty: '1.00', absence_penalty: '5.00' },
      task: { completion_weight: '0.6000', on_time_weight: '0.4000' },
    });
    expect(flattenConfig(json)['weights.goal']).toBe('0.3000');
  });

  it('refuses weights that do not sum to exactly 1.0', () => {
    for (const weights of [
      { attendance: '0.3', task: '0.4', goal: '0.31' },
      { attendance: '0.3333', task: '0.3333', goal: '0.3333' },
      { attendance: '0', task: '0', goal: '0' },
    ]) {
      const result = parsePerformanceConfig({ ...DEFAULT_JSON, weights });
      expect(result.ok).toBe(false);
      expect(!result.ok && result.fields['weights']).toEqual(['must_sum_to_one']);
    }
  });

  it('refuses a weight outside 0–1, each named by its path', () => {
    const result = parsePerformanceConfig({
      ...DEFAULT_JSON,
      weights: { attendance: '1.2', task: '-0.2', goal: '0' },
    });
    expect(!result.ok && result.fields['weights.attendance']).toEqual(['invalid']);
    expect(!result.ok && result.fields['weights.task']).toEqual(['invalid']);
  });

  it('applies the same rule to the task sub-weights', () => {
    const result = parsePerformanceConfig({
      ...DEFAULT_JSON,
      task: { completion_weight: '0.7', on_time_weight: '0.4' },
    });
    expect(!result.ok && result.fields['task']).toEqual(['must_sum_to_one']);
  });

  it('refuses negative or oversized penalties, numbers, extra keys and missing groups', () => {
    const negative = parsePerformanceConfig({
      ...DEFAULT_JSON,
      attendance: { late_penalty: '-1', absence_penalty: '101' },
    });
    expect(!negative.ok && negative.fields['attendance.late_penalty']).toEqual(['invalid']);
    expect(!negative.ok && negative.fields['attendance.absence_penalty']).toEqual(['invalid']);

    const number = parsePerformanceConfig({
      ...DEFAULT_JSON,
      weights: { attendance: 0.3, task: '0.4', goal: '0.3' },
    });
    expect(!number.ok && number.fields['weights.attendance']).toEqual(['invalid']);

    const extra = parsePerformanceConfig({ ...DEFAULT_JSON, bonus: {} });
    expect(!extra.ok && extra.fields['bonus']).toEqual(['invalid']);

    const tooPrecise = parsePerformanceConfig({
      ...DEFAULT_JSON,
      weights: { attendance: '0.30001', task: '0.39999', goal: '0.3' },
    });
    expect(!tooPrecise.ok && tooPrecise.fields['weights.attendance']).toEqual(['invalid']);

    const missing = parsePerformanceConfig({ weights: DEFAULT_JSON.weights });
    expect(!missing.ok && missing.fields['attendance']).toEqual(['required']);
    expect(!missing.ok && missing.fields['task']).toEqual(['required']);
  });

  it('normalises Arabic-Indic digits (DOCUMENT 08 §5.5)', () => {
    const result = parsePerformanceConfig({
      ...DEFAULT_JSON,
      weights: { attendance: '٠٫٣'.replace('٫', '.'), task: '0.4', goal: '0.3' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('attendance score', () => {
  it('reproduces DOCUMENT 14’s worked example: 111.5 → 100 → minus late = 98.00', () => {
    expect(attendanceScore(AHMED_SEPTEMBER, config().attendance)?.toString()).toBe('98.000000');
  });

  it('subtracts absences and clamps at zero', () => {
    const score = attendanceScore(
      { ...AHMED_SEPTEMBER, presentDays: 10, wfhDays: 0, absentDays: 16, lateIncidents: 0 },
      config().attendance,
    );
    // 10 ÷ 26 = 38.46…%, minus 16 × 5 → below zero → 0.
    expect(score?.toString()).toBe('0.000000');
  });

  it('counts paid leave as attended', () => {
    const score = attendanceScore(
      {
        workingDays: 20,
        presentDays: 15,
        wfhDays: 0,
        paidLeaveDays: 5,
        lateIncidents: 0,
        absentDays: 0,
      },
      config().attendance,
    );
    expect(score?.toString()).toBe('100.000000');
  });

  it('follows the configured penalties exactly', () => {
    const lenient = config({
      ...DEFAULT_JSON,
      attendance: { late_penalty: '0', absence_penalty: '0' },
    });
    const harsh = config({
      ...DEFAULT_JSON,
      attendance: { late_penalty: '7.5', absence_penalty: '20' },
    });
    expect(attendanceScore(AHMED_SEPTEMBER, lenient.attendance)?.toString()).toBe('100.000000');
    expect(attendanceScore(AHMED_SEPTEMBER, harsh.attendance)?.toString()).toBe('85.000000');
  });

  it('no working days is no data, not 0% and not 100%', () => {
    expect(
      attendanceScore(
        { ...AHMED_SEPTEMBER, workingDays: 0, presentDays: 0, wfhDays: 0 },
        config().attendance,
      ),
    ).toBeNull();
  });
});

describe('task score', () => {
  it('weights completion and on-time rates by the configured sub-weights', () => {
    // 18 of 23 completed (78.26…%), 15 of 18 on time (83.33…%).
    const result = taskScore({ assigned: 23, completed: 18, completedOnTime: 15 }, config().task);
    expect(result.completionRate?.toString()).toBe('78.260870');
    expect(result.onTimeRate?.toString()).toBe('83.333333');
    // 78.260870 × 0.6 + 83.333333 × 0.4 = 46.956522 + 33.333333
    expect(result.score?.toString()).toBe('80.289855');
  });

  it('no assigned tasks is no task score — excluded, not zero', () => {
    const result = taskScore({ assigned: 0, completed: 0, completedOnTime: 0 }, config().task);
    expect(result).toEqual({ score: null, completionRate: null, onTimeRate: null });
  });

  it('nothing completed: the on-time rate is missing and is renormalised away', () => {
    const result = taskScore({ assigned: 4, completed: 0, completedOnTime: 0 }, config().task);
    expect(result.onTimeRate).toBeNull();
    expect(result.score?.toString()).toBe('0.000000');
  });

  it('follows different sub-weights exactly', () => {
    const completionOnly = config({
      ...DEFAULT_JSON,
      task: { completion_weight: '1', on_time_weight: '0' },
    });
    const result = taskScore(
      { assigned: 4, completed: 2, completedOnTime: 0 },
      completionOnly.task,
    );
    expect(result.score?.toString()).toBe('50.000000');
  });
});

describe('goal score', () => {
  it('averages progress, each capped at 100 for scoring', () => {
    expect(goalScore(['82.00', '90.00'])?.toString()).toBe('86.000000');
    expect(goalScore(['150.00', '50.00'])?.toString()).toBe('75.000000');
  });

  it('no goals is no data', () => {
    expect(goalScore([])).toBeNull();
  });
});

describe('overall — configured weights, renormalised when a component is missing', () => {
  const full: PerformanceInputs = {
    attendance: AHMED_SEPTEMBER,
    task: { assigned: 23, completed: 18, completedOnTime: 15 },
    goalPercents: ['82.00', '90.00'],
  };

  it('reproduces DOCUMENT 14’s worked example with the default weights', () => {
    const result = computePerformance(full, config());
    expect(result.attendance.score).toBe('98.00');
    expect(result.goal.score).toBe('86.00');
    expect(result.task.score).toBe('80.29');
    // 98 × 0.3 + 80.289855 × 0.4 + 86 × 0.3 = 29.4 + 32.115942 + 25.8
    expect(result.overall).toBe('87.32');
    expect(result.effectiveWeights).toEqual({
      attendance: '0.3000',
      task: '0.4000',
      goal: '0.3000',
    });
  });

  it('a company weighting attendance at 0.5 gets a different, equally valid number', () => {
    const result = computePerformance(full, withWeights('0.5', '0.25', '0.25'));
    // 98 × 0.5 + 80.289855 × 0.25 + 86 × 0.25 = 49 + 20.072464 + 21.5
    expect(result.overall).toBe('90.57');
  });

  it('every single-component configuration yields exactly that component', () => {
    expect(computePerformance(full, withWeights('1', '0', '0')).overall).toBe('98.00');
    expect(computePerformance(full, withWeights('0', '1', '0')).overall).toBe('80.29');
    expect(computePerformance(full, withWeights('0', '0', '1')).overall).toBe('86.00');
  });

  it('an employee with no assigned tasks: excluded and the rest renormalised', () => {
    const result = computePerformance(
      { ...full, task: { assigned: 0, completed: 0, completedOnTime: 0 } },
      config(),
    );
    expect(result.task.score).toBeNull();
    // (98 × 0.3 + 86 × 0.3) ÷ 0.6 = 92
    expect(result.overall).toBe('92.00');
    expect(result.effectiveWeights).toEqual({ attendance: '0.5000', task: null, goal: '0.5000' });
  });

  it('never scores a missing component as zero', () => {
    const missingGoals = computePerformance({ ...full, goalPercents: [] }, config());
    const zeroGoals = computePerformance({ ...full, goalPercents: ['0.00'] }, config());
    expect(missingGoals.overall).not.toBe(zeroGoals.overall);
    // (98 × 0.3 + 80.289855 × 0.4) ÷ 0.7
    expect(missingGoals.overall).toBe('87.88');
  });

  it('no data at all is "no data" — null everywhere, not 0%', () => {
    const result = computePerformance(
      {
        attendance: {
          ...AHMED_SEPTEMBER,
          workingDays: 0,
          presentDays: 0,
          wfhDays: 0,
          lateIncidents: 0,
        },
        task: { assigned: 0, completed: 0, completedOnTime: 0 },
        goalPercents: [],
      },
      config(),
    );
    expect(result.overall).toBeNull();
    expect(result.attendance.score).toBeNull();
    expect(result.task.score).toBeNull();
    expect(result.goal.score).toBeNull();
    expect(result.effectiveWeights).toEqual({ attendance: null, task: null, goal: null });
  });

  it('a component with data but zero weight leaves "no data" when it is all that remains', () => {
    const result = computePerformance(
      { ...full, task: { assigned: 0, completed: 0, completedOnTime: 0 }, goalPercents: [] },
      withWeights('0', '0.5', '0.5'),
    );
    expect(result.attendance.score).toBe('98.00');
    expect(result.overall).toBeNull();
  });

  it('an unreadable schedule means no attendance component', () => {
    const result = computePerformance({ ...full, attendance: null }, config());
    expect(result.attendance.score).toBeNull();
    expect(result.overall).not.toBeNull();
  });
});

describe('DOCUMENT 25 Phase 8 exit — no weight or coefficient in the engine', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./performance-rules.ts', import.meta.url)),
    'utf8',
  )
    // Comments may quote DOCUMENT 14's formula and example; code may not.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  it('contains no decimal literal at all', () => {
    expect(source).not.toMatch(/\b\d+\.\d+\b/);
  });

  it('contains none of DOCUMENT 14’s default weights or penalties as literals', () => {
    for (const literal of ['0.3', '0.4', '0.6', '.30', '.40', '.60', '5.0', '1.0']) {
      expect(source).not.toContain(literal);
    }
  });

  it('every integer literal is structural: zero, a scale, or the percentage base', () => {
    const integers = [...source.matchAll(/(?<![\w.])(\d+)(?![\w.])/g)].map((match) => match[1]);
    expect(new Set(integers)).toEqual(new Set(['0', '2', '6', '100']));
  });
});
