/**
 * DOCUMENT 13 rules 1–5 and OD-10 — the half of the DOCUMENT 25 Phase 7 exit
 * criterion that is arithmetic and a matrix. The HTTP half (the server
 * actually applies these) is `test/tasks.e2e.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  STATUS_TRANSITIONS,
  TASK_STATUSES,
  allowedTransitions,
  computeProgress,
  isAllowedTransition,
  isOverdue,
  isReopen,
  statusAfterFirstActivity,
  transitionRequiresReason,
} from './task-rules.js';
import type { TaskStatusValue } from './task-rules.js';

const progress = (
  completedItems: number,
  totalItems: number,
  status: TaskStatusValue = 'in_progress',
  currentPercent = '0.00',
): string => computeProgress({ completedItems, totalItems, status, currentPercent });

describe('computeProgress — with a checklist (DOCUMENT 13 rule 2)', () => {
  it('is DOCUMENT 13’s own example: 6 of 8 → 75%', () => {
    expect(progress(6, 8)).toBe('75.00');
  });

  it('is 0% with nothing ticked and 100% with everything ticked', () => {
    expect(progress(0, 5)).toBe('0.00');
    expect(progress(5, 5)).toBe('100.00');
  });

  it('is exact for every count of a one- to twelve-item list', () => {
    for (let total = 1; total <= 12; total += 1) {
      for (let done = 0; done <= total; done += 1) {
        // Independent oracle, in BigInt: round-half-up(done × 10000 ÷ total)
        // hundredths, then formatted by hand.
        const hundredths = (BigInt(done) * 20000n + BigInt(total)) / (2n * BigInt(total));
        const expected = `${String(hundredths / 100n)}.${String(hundredths % 100n).padStart(2, '0')}`;
        expect(progress(done, total)).toBe(expected);
      }
    }
  });

  it('rounds thirds and sixths half up, without floating-point drift', () => {
    expect(progress(1, 3)).toBe('33.33');
    expect(progress(2, 3)).toBe('66.67');
    expect(progress(1, 6)).toBe('16.67');
    expect(progress(1, 8)).toBe('12.50');
    expect(progress(1, 7)).toBe('14.29');
  });

  it('a large list keeps two decimals and stays inside DECIMAL(5,2)', () => {
    expect(progress(1, 1000)).toBe('0.10');
    expect(progress(999, 1000)).toBe('99.90');
    expect(progress(2, 30000)).toBe('0.01');
  });

  it('follows the checklist whatever the status — including after completion', () => {
    // DOCUMENT 13 edge case: a checklist added after completion recalculates
    // progress; the task stays completed (the status is not touched here).
    expect(progress(0, 1, 'completed', '100.00')).toBe('0.00');
    expect(progress(1, 2, 'on_hold', '0.00')).toBe('50.00');
    expect(progress(2, 4, 'cancelled', '10.00')).toBe('50.00');
    expect(progress(3, 4, 'not_started')).toBe('75.00');
  });

  it('adding an item grows the denominator; deleting one shrinks it (FLOW 11)', () => {
    expect(progress(2, 4)).toBe('50.00');
    expect(progress(2, 5)).toBe('40.00'); // an open item added
    expect(progress(2, 3)).toBe('66.67'); // an open item deleted
    expect(progress(1, 3)).toBe('33.33'); // a ticked item deleted
  });

  it('refuses impossible counts rather than producing a number', () => {
    expect(() => progress(3, 2)).toThrow(RangeError);
    expect(() => progress(-1, 2)).toThrow(RangeError);
    expect(() => progress(1.5, 2)).toThrow(RangeError);
  });
});

describe('computeProgress — no checklist (DOCUMENT 13 rule 3, OD-10 option A)', () => {
  it('derives 0 / 50 / 100 from status', () => {
    expect(progress(0, 0, 'not_started', '30.00')).toBe('0.00');
    expect(progress(0, 0, 'in_progress', '0.00')).toBe('50.00');
    expect(progress(0, 0, 'completed', '50.00')).toBe('100.00');
  });

  it('on hold and cancelled keep the progress the task already had', () => {
    expect(progress(0, 0, 'on_hold', '50.00')).toBe('50.00');
    expect(progress(0, 0, 'on_hold', '0.00')).toBe('0.00');
    expect(progress(0, 0, 'cancelled', '50.00')).toBe('50.00');
  });

  it('all items deleted falls back to the status rule without dividing by zero', () => {
    // Edge case "All checklist items deleted": 2 of 4 was 50%, then all four
    // are removed from an in-progress task.
    expect(progress(0, 0, 'in_progress', '50.00')).toBe('50.00');
    expect(progress(0, 0, 'completed', '75.00')).toBe('100.00');
    expect(progress(0, 0, 'not_started', '25.00')).toBe('0.00');
  });
});

describe('status transitions (DOCUMENT 13 rule 4)', () => {
  const ALLOWED: ReadonlyArray<readonly [TaskStatusValue, TaskStatusValue]> = [
    ['not_started', 'in_progress'],
    ['not_started', 'cancelled'],
    ['not_started', 'on_hold'],
    ['in_progress', 'completed'],
    ['in_progress', 'on_hold'],
    ['in_progress', 'cancelled'],
    ['on_hold', 'in_progress'],
    ['on_hold', 'cancelled'],
    ['completed', 'in_progress'],
  ];

  it('allows exactly the nine documented transitions, out of all 25 pairs', () => {
    const allowed = TASK_STATUSES.flatMap((from) =>
      TASK_STATUSES.filter((to) => isAllowedTransition(from, to)).map((to) => [from, to]),
    );
    expect(allowed).toEqual(expect.arrayContaining(ALLOWED.map((pair) => [...pair])));
    expect(allowed).toHaveLength(ALLOWED.length);
  });

  it('refuses every same-status "transition" — a no-op is an error, not silence', () => {
    for (const status of TASK_STATUSES) {
      expect(isAllowedTransition(status, status)).toBe(false);
    }
  });

  it('cancelled is terminal', () => {
    expect(allowedTransitions('cancelled')).toEqual([]);
    expect(isAllowedTransition('cancelled', 'completed')).toBe(false);
  });

  it('a task cannot jump from not started or on hold straight to completed', () => {
    expect(isAllowedTransition('not_started', 'completed')).toBe(false);
    expect(isAllowedTransition('on_hold', 'completed')).toBe(false);
  });

  it('a completed task only reopens; it cannot be cancelled or paused', () => {
    expect(STATUS_TRANSITIONS.completed).toEqual(['in_progress']);
    expect(isReopen('completed', 'in_progress')).toBe(true);
    expect(isReopen('on_hold', 'in_progress')).toBe(false);
  });

  it('requires a reason to cancel (rule 7) and to reopen (rule 4), and nowhere else', () => {
    const needing = TASK_STATUSES.flatMap((from) =>
      TASK_STATUSES.filter(
        (to) => isAllowedTransition(from, to) && transitionRequiresReason(from, to),
      ).map((to) => `${from}→${to}`),
    );
    expect(needing.sort()).toEqual(
      [
        'not_started→cancelled',
        'in_progress→cancelled',
        'on_hold→cancelled',
        'completed→in_progress',
      ].sort(),
    );
  });
});

describe('first activity (DOCUMENT 13 rule 5)', () => {
  it('moves only not_started to in_progress', () => {
    expect(statusAfterFirstActivity('not_started')).toBe('in_progress');
    expect(statusAfterFirstActivity('in_progress')).toBe('in_progress');
    expect(statusAfterFirstActivity('on_hold')).toBe('on_hold');
    expect(statusAfterFirstActivity('completed')).toBe('completed');
    expect(statusAfterFirstActivity('cancelled')).toBe('cancelled');
  });
});

describe('overdue (DOCUMENT 13 rule 1)', () => {
  const today = '2026-03-10';

  it('is a past deadline on an open task', () => {
    expect(isOverdue({ deadline: '2026-03-09', status: 'not_started' }, today)).toBe(true);
    expect(isOverdue({ deadline: '2026-03-09', status: 'in_progress' }, today)).toBe(true);
    expect(isOverdue({ deadline: '2026-03-09', status: 'on_hold' }, today)).toBe(true);
  });

  it('is never a deadline of today or later', () => {
    expect(isOverdue({ deadline: today, status: 'in_progress' }, today)).toBe(false);
    expect(isOverdue({ deadline: '2026-03-11', status: 'in_progress' }, today)).toBe(false);
  });

  it('is never a completed or cancelled task, and never a task without a deadline', () => {
    expect(isOverdue({ deadline: '2026-01-01', status: 'completed' }, today)).toBe(false);
    expect(isOverdue({ deadline: '2026-01-01', status: 'cancelled' }, today)).toBe(false);
    expect(isOverdue({ deadline: null, status: 'in_progress' }, today)).toBe(false);
  });

  it('compares calendar dates across a month and a year boundary', () => {
    expect(isOverdue({ deadline: '2026-02-28', status: 'in_progress' }, '2026-03-01')).toBe(true);
    expect(isOverdue({ deadline: '2025-12-31', status: 'in_progress' }, '2026-01-01')).toBe(true);
  });
});
