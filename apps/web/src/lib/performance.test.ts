/**
 * The performance screens' pure rules — DOCUMENT 14 "Validation" and "Error
 * states" ("settings save blocked with the current sum shown").
 */

import { describe, expect, it } from 'vitest';

import { bodyFromForm, formFromConfig, scoreText, weightSum, weightUnits } from './performance';
import type { PerformanceConfig } from './performance';

describe('the live weight sum', () => {
  it('adds in ten-thousandths, with no float error', () => {
    expect(weightSum(['0.3', '0.4', '0.3'])).toEqual({ sum: '1.0000', isWhole: true });
    expect(weightSum(['0.1', '0.2', '0.7'])).toEqual({ sum: '1.0000', isWhole: true });
    expect(weightSum(['0.3333', '0.3333', '0.3333'])).toEqual({ sum: '0.9999', isWhole: false });
    expect(weightSum(['0.5', '0.6'])).toEqual({ sum: '1.1000', isWhole: false });
  });

  it('cannot sum what it cannot read', () => {
    expect(weightSum(['0.3', 'abc', '0.7'])).toEqual({ sum: null, isWhole: false });
    expect(weightUnits('0.12345')).toBeNull();
    expect(weightUnits('-0.1')).toBeNull();
  });

  it('reads Arabic-Indic digits', () => {
    expect(weightUnits('٠.٥')).toBe(5000);
    expect(weightUnits('۱')).toBe(10000);
  });
});

describe('the form and the body', () => {
  it('round-trips the stored configuration', () => {
    const config: PerformanceConfig = {
      schema_version: 1,
      weights: { attendance: '0.3000', task: '0.4000', goal: '0.3000' },
      attendance: { late_penalty: '1.00', absence_penalty: '5.00' },
      task: { completion_weight: '0.6000', on_time_weight: '0.4000' },
      updated_at: '2026-03-01T00:00:00.000Z',
      updated_by: null,
    };
    expect(bodyFromForm(formFromConfig(config))).toEqual({
      weights: config.weights,
      attendance: config.attendance,
      task: config.task,
    });
  });
});

describe('"no data" is never 0%', () => {
  it('formats a score, and leaves a missing one missing', () => {
    expect(scoreText('87.32')).toBe('87.32%');
    expect(scoreText('60.00')).toBe('60%');
    expect(scoreText('0.00')).toBe('0%');
    expect(scoreText(null)).toBeNull();
  });
});
