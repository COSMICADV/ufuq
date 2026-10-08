/**
 * The employee dashboard's pure rules — DOCUMENT 04 C1.
 */

import { describe, expect, it } from 'vitest';

import { dueTodayCount, isNewcomer, isOpenTask, nextTasks } from './employee-dashboard';
import type { TaskStatus } from './tasks';

function task(id: string, status: TaskStatus, deadline: string | null) {
  return { id, status, deadline };
}

const TODAY = '2026-03-10';

describe('C1 component 3 — my tasks', () => {
  it('open means neither completed nor cancelled', () => {
    expect(isOpenTask({ status: 'not_started' })).toBe(true);
    expect(isOpenTask({ status: 'in_progress' })).toBe(true);
    expect(isOpenTask({ status: 'on_hold' })).toBe(true);
    expect(isOpenTask({ status: 'completed' })).toBe(false);
    expect(isOpenTask({ status: 'cancelled' })).toBe(false);
  });

  it('counts open tasks due today, whatever their status', () => {
    expect(
      dueTodayCount(
        [
          task('a', 'not_started', TODAY),
          task('b', 'in_progress', TODAY),
          task('c', 'completed', TODAY),
          task('d', 'cancelled', TODAY),
          task('e', 'in_progress', '2026-03-11'),
          task('f', 'in_progress', null),
        ],
        TODAY,
      ),
    ).toBe(2);
  });

  it('lists the next three open tasks by deadline, from today on', () => {
    const next = nextTasks(
      [
        task('later', 'not_started', '2026-03-20'),
        task('overdue', 'in_progress', '2026-03-01'),
        task('done', 'completed', '2026-03-11'),
        task('none', 'in_progress', null),
        task('today', 'on_hold', TODAY),
        task('soon', 'in_progress', '2026-03-12'),
        task('last', 'not_started', '2026-04-01'),
      ],
      TODAY,
    );
    expect(next.map((t) => t.id)).toEqual(['today', 'soon', 'later']);
  });

  it('returns fewer when fewer qualify', () => {
    expect(nextTasks([task('a', 'completed', TODAY)], TODAY)).toEqual([]);
  });
});

describe('C1 "Empty" — the welcome card', () => {
  it('is shown only with no tasks and no goals', () => {
    expect(isNewcomer({ tasks: 0, goals: 0 })).toBe(true);
    expect(isNewcomer({ tasks: 1, goals: 0 })).toBe(false);
    expect(isNewcomer({ tasks: 0, goals: 1 })).toBe(false);
  });
});
