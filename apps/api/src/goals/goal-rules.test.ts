/**
 * DOCUMENT 14 business rules 1, 2, 4, 6, 7 and 8, proved without a database —
 * DOCUMENT 26 §2 "Goal progress: under, at, and over target; zero target
 * rejected; percentage-unit goals".
 */

import { describe, expect, it } from 'vitest';

import {
  closingDate,
  DEFAULT_TASK_COUNT_RULE,
  daysRemaining,
  deriveStatus,
  displayPercent,
  effectiveTarget,
  isAutomatic,
  isValidPeriod,
  milestonesCrossed,
  milestonesReached,
  parseTaskCountRule,
  periodsOverlap,
  progressPercent,
} from './goal-rules.js';

describe('rule 1 — progress = current ÷ target × 100', () => {
  it('reproduces DOCUMENT 14’s three worked examples', () => {
    // Sales — 75,000 of 100,000 EGP.
    expect(progressPercent('75000.00', '100000.00')).toBe('75.00');
    // Task — 15 of 20 tasks.
    expect(progressPercent('15', '20')).toBe('75.00');
    // Custom — satisfaction 84% against a 90% target: 93.3% toward target.
    expect(progressPercent('84', '90')).toBe('93.33');
  });

  it('is exact under, at and over target', () => {
    expect(progressPercent('0', '20')).toBe('0.00');
    expect(progressPercent('20', '20')).toBe('100.00');
    expect(progressPercent('22.40', '20')).toBe('112.00');
    expect(progressPercent('150', '100')).toBe('150.00');
  });

  it('rounds to the nearest hundredth, half away from zero, with no float in the way', () => {
    expect(progressPercent('1', '3')).toBe('33.33');
    expect(progressPercent('2', '3')).toBe('66.67');
    expect(progressPercent('0.01', '0.08')).toBe('12.50');
    // 0.1 + 0.2 is the classic float trap; as decimals it is exactly 30%.
    expect(progressPercent('0.30', '1')).toBe('30.00');
  });

  it('keeps a very large over-achievement rather than refusing it', () => {
    expect(progressPercent('9999999999999.99', '0.01')).toBe('99999999999999900.00');
  });

  it('refuses a zero target — it would divide by zero (DOCUMENT 14 errors)', () => {
    expect(() => progressPercent('5', '0')).toThrow(RangeError);
    expect(() => progressPercent('5', '0.00')).toThrow(RangeError);
  });

  it('refuses a negative value', () => {
    expect(() => progressPercent('-1', '10')).toThrow(RangeError);
  });
});

describe('rule 2 — display capped at 100%, true value retained', () => {
  it('caps only the display', () => {
    const truth = progressPercent('112', '100');
    expect(truth).toBe('112.00');
    expect(displayPercent(truth)).toBe('100.00');
    expect(displayPercent('99.99')).toBe('99.99');
    expect(displayPercent('100.00')).toBe('100.00');
  });
});

describe('rules 3 and 4 — who supplies the value', () => {
  it('only Task goals are derived; Sales and Custom are manual', () => {
    expect(isAutomatic('task')).toBe(true);
    expect(isAutomatic('sales')).toBe(false);
    expect(isAutomatic('custom')).toBe(false);
  });
});

describe('rule 6 — milestone detection at 25 / 50 / 75 / 100', () => {
  it('detects each milestone crossed on the way up, including several at once', () => {
    expect(milestonesCrossed('0.00', '24.99')).toEqual([]);
    expect(milestonesCrossed('0.00', '25.00')).toEqual([25]);
    expect(milestonesCrossed('24.99', '50.00')).toEqual([25, 50]);
    expect(milestonesCrossed('10.00', '112.00')).toEqual([25, 50, 75, 100]);
    expect(milestonesCrossed(null, '80.00')).toEqual([25, 50, 75]);
  });

  it('does not fire again for a milestone already passed', () => {
    expect(milestonesCrossed('25.00', '49.99')).toEqual([]);
    expect(milestonesCrossed('100.00', '150.00')).toEqual([]);
  });

  it('a decrease crosses nothing; climbing back fires again', () => {
    expect(milestonesCrossed('80.00', '40.00')).toEqual([]);
    expect(milestonesCrossed('40.00', '80.00')).toEqual([50, 75]);
  });

  it('lists what a value has reached', () => {
    expect(milestonesReached('74.99')).toEqual([25, 50]);
    expect(milestonesReached('0.00')).toEqual([]);
  });
});

describe('rule 7 — period end decides achieved or missed', () => {
  const base = { status: 'active' as const, closesOn: '2026-03-31' };

  it('stays active up to and including the last day', () => {
    expect(deriveStatus({ ...base, progressPercent: '10.00', today: '2026-03-31' })).toBe('active');
    expect(deriveStatus({ ...base, progressPercent: '150.00', today: '2026-03-15' })).toBe(
      'active',
    );
  });

  it('after the last day: achieved at 100% or more, otherwise missed', () => {
    expect(deriveStatus({ ...base, progressPercent: '100.00', today: '2026-04-01' })).toBe(
      'achieved',
    );
    expect(deriveStatus({ ...base, progressPercent: '112.00', today: '2026-04-01' })).toBe(
      'achieved',
    );
    expect(deriveStatus({ ...base, progressPercent: '99.99', today: '2026-04-01' })).toBe('missed');
  });

  it('re-derives a closed goal — rule 9 recalculation and reopening', () => {
    // A late figure turns missed into achieved.
    expect(
      deriveStatus({
        status: 'missed',
        closesOn: '2026-03-31',
        progressPercent: '100.00',
        today: '2026-04-02',
      }),
    ).toBe('achieved');
    // Extending a closed goal's period makes it active again.
    expect(
      deriveStatus({
        status: 'achieved',
        closesOn: '2026-04-30',
        progressPercent: '100.00',
        today: '2026-04-02',
      }),
    ).toBe('active');
  });

  it('cancellation is final', () => {
    expect(
      deriveStatus({
        status: 'cancelled',
        closesOn: '2026-03-31',
        progressPercent: '100.00',
        today: '2026-04-05',
      }),
    ).toBe('cancelled');
  });

  it('counts the days left', () => {
    expect(daysRemaining('2026-03-31', '2026-03-10')).toBe(21);
    expect(daysRemaining('2026-03-31', '2026-03-31')).toBe(0);
    expect(daysRemaining('2026-03-31', '2026-04-03')).toBe(0);
  });
});

describe('DOCUMENT 14 edge case — owner terminated mid-period', () => {
  it('closes the goal at the termination date', () => {
    expect(closingDate('2026-03-31', '2026-03-15')).toBe('2026-03-15');
    expect(closingDate('2026-03-31', null)).toBe('2026-03-31');
    expect(closingDate('2026-03-31', '2026-04-10')).toBe('2026-03-31');
  });

  it('judges it against the elapsed portion of the target', () => {
    // 1–31 March is 31 days; terminated on the 15th leaves 15 of them.
    expect(effectiveTarget('31000.00', '2026-03-01', '2026-03-31', '2026-03-15')).toBe('15000.00');
    expect(effectiveTarget('20', '2026-03-01', '2026-03-31', null)).toBe('20.00');
    expect(effectiveTarget('20', '2026-03-01', '2026-03-31', '2026-03-31')).toBe('20.00');
    // Never zero.
    expect(effectiveTarget('0.01', '2026-01-01', '2026-12-31', '2026-01-01')).toBe('0.01');
  });
});

describe('rule 8 — periods', () => {
  it('requires the end strictly after the start', () => {
    expect(isValidPeriod('2026-03-01', '2026-03-31')).toBe(true);
    expect(isValidPeriod('2026-03-01', '2026-03-01')).toBe(false);
    expect(isValidPeriod('2026-03-31', '2026-03-01')).toBe(false);
  });

  it('detects overlap, edges included', () => {
    const march = { start: '2026-03-01', end: '2026-03-31' };
    expect(periodsOverlap(march, { start: '2026-03-31', end: '2026-04-30' })).toBe(true);
    expect(periodsOverlap(march, { start: '2026-04-01', end: '2026-04-30' })).toBe(false);
    expect(periodsOverlap(march, { start: '2026-02-01', end: '2026-04-30' })).toBe(true);
  });
});

describe('rule 4 — task_count_rule, version 1', () => {
  it('accepts a valid rule and returns priorities in canonical order', () => {
    expect(parseTaskCountRule({ version: 1, priorities: ['urgent', 'high'] })).toEqual({
      version: 1,
      priorities: ['high', 'urgent'],
    });
    expect(parseTaskCountRule(DEFAULT_TASK_COUNT_RULE)).toEqual(DEFAULT_TASK_COUNT_RULE);
  });

  it('no priority selected means every priority counts, stored explicitly', () => {
    expect(parseTaskCountRule({ version: 1, priorities: [] })).toEqual(DEFAULT_TASK_COUNT_RULE);
    expect(parseTaskCountRule({ version: 1 })).toEqual(DEFAULT_TASK_COUNT_RULE);
    expect(DEFAULT_TASK_COUNT_RULE.priorities).toEqual(['low', 'medium', 'high', 'urgent']);
  });

  it('refuses anything else', () => {
    for (const bad of [
      null,
      [],
      'all',
      {},
      { version: 2, priorities: ['low'] },
      { priorities: [] },
      { version: 1, priorities: 'all' },
      { version: 1, priorities: null },
      { version: 1, priorities: ['critical'] },
      { version: 1, priorities: ['low', 'low'] },
      { version: 1, priorities: ['low'], department_id: 'x' },
    ]) {
      expect(parseTaskCountRule(bad)).toBeNull();
    }
  });
});
