import { describe, expect, it } from 'vitest';

import {
  addMonths,
  budgetStatus,
  monthlyResults,
  monthsBetween,
  normaliseThresholds,
  parseMonth,
} from './budget-rules.js';

describe('months', () => {
  it('parses, adds across years, and caps the history', () => {
    expect(parseMonth('2026-13')).toBeNull();
    expect(addMonths({ year: 2026, month: 11 }, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(monthsBetween({ year: 2026, month: 9 }, { year: 2026, month: 11 })).toHaveLength(3);
    expect(monthsBetween({ year: 2026, month: 12 }, { year: 2026, month: 11 })).toEqual([]);
    expect(monthsBetween({ year: 2020, month: 1 }, { year: 2026, month: 11 })).toHaveLength(24);
  });
});

describe('monthlyResults', () => {
  const months = [
    { month: '2026-09', spent: '800.00' },
    { month: '2026-10', spent: '1300.00' },
    { month: '2026-11', spent: '100.50' },
  ];
  it('starts every month from the amount without rollover', () => {
    const r = monthlyResults('1000', months, false);
    expect(r.map((m) => m.limit)).toEqual(['1000.00', '1000.00', '1000.00']);
    expect(r[1]?.remaining).toBe('-300.00');
  });
  it('carries what was left, and what was overspent, into the next month', () => {
    const r = monthlyResults('1000', months, true);
    expect(r.map((m) => m.carried)).toEqual(['0.00', '200.00', '-100.00']);
    expect(r.map((m) => m.limit)).toEqual(['1000.00', '1200.00', '900.00']);
    expect(r[2]?.remaining).toBe('799.50');
  });
});

describe('budgetStatus', () => {
  const alerts = [80, 90, 100];
  it('is ok below the first alert', () => {
    expect(budgetStatus('790.00', '1000.00', alerts)).toEqual({ percent: 79, level: null, state: 'ok' });
  });
  it('reports the highest threshold reached, flooring the percent', () => {
    expect(budgetStatus('899.99', '1000.00', alerts)).toEqual({ percent: 89, level: 80, state: 'warning' });
    expect(budgetStatus('900.00', '1000.00', alerts)).toEqual({ percent: 90, level: 90, state: 'warning' });
  });
  it('separates exactly reached from over', () => {
    expect(budgetStatus('1000.00', '1000.00', alerts).state).toBe('reached');
    expect(budgetStatus('1000.01', '1000.00', alerts)).toEqual({ percent: 100, level: 100, state: 'over' });
    expect(budgetStatus('2500.00', '1000.00', alerts).percent).toBe(250);
  });
  it('treats a limit rolled to zero or below as over once anything is spent', () => {
    expect(budgetStatus('0.00', '0.00', alerts).state).toBe('ok');
    expect(budgetStatus('5.00', '0.00', alerts).state).toBe('over');
    expect(budgetStatus('0.00', '-50.00', alerts).state).toBe('over');
  });
  it('honours the person’s own thresholds', () => {
    expect(budgetStatus('760.00', '1000.00', [75]).level).toBe(75);
    expect(budgetStatus('760.00', '1000.00', []).state).toBe('ok');
  });
});

describe('normaliseThresholds', () => {
  it('keeps known choices, unique and ascending', () => {
    expect(normaliseThresholds([100, 80, 80, 33, 90])).toEqual([80, 90, 100]);
  });
});
