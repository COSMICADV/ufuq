/**
 * The goal screens' pure rules — DOCUMENT 14, DOCUMENT 04 B11–B12 / C7.
 */

import { describe, expect, it } from 'vitest';

import {
  apiQueryForGoalFilters,
  chartPoints,
  countedPriorities,
  createBody,
  EMPTY_GOAL_FORM,
  formFromGoal,
  goalFiltersFromParams,
  goalPath,
  goalsPath,
  newGoalPath,
  periodIsValid,
  progressParts,
  searchForGoalFilters,
  updateBody,
  valueWithUnit,
} from './goals';
import type { Goal, GoalHistoryRow } from './goals';

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    type: 'sales',
    title: 'March sales',
    description: null,
    employee: {
      id: 'e1',
      employee_code: 'E-1',
      first_name: 'Omar',
      last_name: 'Fathy',
      status: 'active',
    },
    target_value: '100000.00',
    current_value: '75000.00',
    unit: 'EGP',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    status: 'active',
    task_count_rule: null,
    is_automatic: false,
    progress_percent: '75.00',
    progress_display_percent: '75.00',
    effective_target_value: '100000.00',
    closes_on: '2026-03-31',
    days_remaining: 21,
    created_by: { user_id: 'u1', employee_id: null, name: 'admin@a.test' },
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

function row(percent: string, id: string): GoalHistoryRow {
  return {
    id,
    goal_id: 'g1',
    value: '1.00',
    previous_value: null,
    target_value: '1.00',
    progress_percent: percent,
    note: null,
    source: 'manual',
    author: { user_id: 'u1', employee_id: null, name: 'a' },
    created_at: '2026-03-01T00:00:00.000Z',
  };
}

describe('DOCUMENT 14 rule 2 — the capped bar beside the true figure', () => {
  it('keeps the true value visible when over-achieved', () => {
    const parts = progressParts(
      goal({ progress_percent: '112.00', progress_display_percent: '100.00' }),
    );
    expect(parts).toEqual({ bar: '100.00', truth: '112', overAchieved: true });
  });

  it('a percentage-unit goal’s value and its progress are two numbers', () => {
    const custom = goal({ unit: '%', current_value: '84.00', progress_percent: '93.33' });
    expect(valueWithUnit(custom.current_value, custom.unit)).toBe('84%');
    expect(progressParts(custom).truth).toBe('93.33');
    expect(valueWithUnit('75000.00', 'EGP')).toBe('75000 EGP');
  });
});

describe('the progress chart', () => {
  it('draws oldest first, against the row’s own progress, with 100% always on the scale', () => {
    const { points, ceiling } = chartPoints([
      row('75.00', 'c'),
      row('50.00', 'b'),
      row('0.00', 'a'),
    ]);
    expect(ceiling).toBe(100);
    expect(points.map((p) => p.percent)).toEqual(['0.00', '50.00', '75.00']);
    expect(points.map((p) => p.x)).toEqual([0, 0.5, 1]);
    expect(points[1]?.y).toBe(0.5);
  });

  it('raises the scale for over-achievement', () => {
    const { ceiling, points } = chartPoints([row('150.00', 'b'), row('0.00', 'a')]);
    expect(ceiling).toBe(150);
    expect(points[1]?.y).toBe(1);
  });

  it('centres a single point', () => {
    expect(chartPoints([row('10.00', 'a')]).points[0]?.x).toBe(0.5);
  });
});

describe('the create / edit form', () => {
  it('sends only the fields a type takes', () => {
    const base = {
      ...EMPTY_GOAL_FORM,
      employee_id: 'e1',
      title: 'x',
      target_value: '20',
      unit: 'pts',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
    };
    expect(createBody({ ...base, type: 'sales' })).not.toHaveProperty('unit');
    expect(createBody({ ...base, type: 'sales' })).not.toHaveProperty('task_count_rule');
    expect(createBody({ ...base, type: 'custom' })).toMatchObject({ unit: 'pts' });
    expect(createBody({ ...base, type: 'task', priorities: ['high'] })).toMatchObject({
      task_count_rule: { version: 1, priorities: ['high'] },
    });
    expect(createBody({ ...base, type: 'task' })).not.toHaveProperty('unit');
  });

  it('no priority selected counts every priority (the approved V1 rule)', () => {
    expect(countedPriorities([])).toEqual(['low', 'medium', 'high', 'urgent']);
    expect(countedPriorities(['urgent', 'low'])).toEqual(['low', 'urgent']);
    const body = createBody({
      ...EMPTY_GOAL_FORM,
      type: 'task',
      employee_id: 'e1',
      title: 'x',
      target_value: '5',
      period_start: '2026-03-01',
      period_end: '2026-03-31',
      priorities: [],
    });
    expect(body).toMatchObject({
      task_count_rule: { version: 1, priorities: ['low', 'medium', 'high', 'urgent'] },
    });
    const allFour = goal({
      type: 'task',
      unit: 'tasks',
      task_count_rule: { version: 1, priorities: ['low', 'medium', 'high', 'urgent'] },
    });
    // Clearing every box on an all-priorities goal is no change at all.
    expect(updateBody(allFour, { ...formFromGoal(allFour), priorities: [] })).toEqual({});
  });

  it('an edit sends only what changed', () => {
    const current = goal();
    const form = formFromGoal(current);
    expect(form.target_value).toBe('100000');
    expect(updateBody(current, form)).toEqual({});
    expect(updateBody(current, { ...form, target_value: '120000', title: 'Renamed' })).toEqual({
      target_value: '120000',
      title: 'Renamed',
    });
    const taskGoal = goal({
      type: 'task',
      unit: 'tasks',
      task_count_rule: { version: 1, priorities: ['low', 'high'] },
    });
    expect(
      updateBody(taskGoal, { ...formFromGoal(taskGoal), priorities: ['high', 'low', 'urgent'] }),
    ).toEqual({
      task_count_rule: { version: 1, priorities: ['low', 'high', 'urgent'] },
    });
  });

  it('hints that the period must end after it starts', () => {
    expect(periodIsValid('2026-03-01', '2026-03-31')).toBe(true);
    expect(periodIsValid('2026-03-01', '2026-03-01')).toBe(false);
    expect(periodIsValid('', '2026-03-01')).toBe(true);
  });
});

describe('admin list filters in the URL', () => {
  it('drops values the API would refuse and round-trips the rest', () => {
    const filters = goalFiltersFromParams(new URLSearchParams('type=task&status=nope&page=2'));
    expect(filters).toEqual({ type: 'task', status: '', page: 2 });
    expect(searchForGoalFilters(filters)).toBe('?type=task&page=2');
    expect(apiQueryForGoalFilters(filters, 20)).toEqual({
      page: '2',
      per_page: '20',
      type: 'task',
    });
  });
});

describe('paths', () => {
  it('names each screen', () => {
    expect(goalPath('ar', 'g1')).toBe('/ar/admin/goals/g1');
    expect(goalPath('en', 'g1', 'app')).toBe('/en/app/goals/g1');
    expect(goalsPath('ar')).toBe('/ar/admin/goals');
    expect(goalsPath('en', 'app')).toBe('/en/app/goals');
    expect(newGoalPath('ar', 'e 1')).toBe('/ar/admin/goals/new?employee=e%201');
  });
});
