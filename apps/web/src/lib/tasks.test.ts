import { describe, expect, it } from 'vitest';

import {
  EMPTY_EMPLOYEE_TASK_FILTERS,
  EMPTY_TASK_FILTERS,
  activeTaskFilterCount,
  apiQueryForEmployeeTasks,
  employeeTaskFiltersFromParams,
  newTaskPath,
  searchForEmployeeTaskFilters,
  apiQueryForTaskFilters,
  applyTick,
  formatPercent,
  groupMyTasks,
  hasActiveTaskFilters,
  moveItem,
  myTaskGroup,
  needsReason,
  progressValue,
  searchForTaskFilters,
  taskFiltersFromParams,
  todayIn,
  transitionAction,
} from './tasks';
import type { TaskDetail, TaskStatus } from './tasks';

const TODAY = '2026-03-10';

function task(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 't1',
    title: 'Report',
    description: null,
    assignee: {
      id: 'e1',
      employee_code: 'E-1',
      first_name: 'Omar',
      last_name: 'Fathy',
      status: 'active',
    },
    department: null,
    priority: 'medium',
    status: 'not_started',
    goal: null,
    start_date: null,
    deadline: null,
    completed_at: null,
    progress_percent: '0.00',
    is_overdue: false,
    cancelled_reason: null,
    checklist_total: 0,
    checklist_completed: 0,
    allowed_transitions: [],
    created_by: { user_id: 'u1', employee_id: null, name: 'admin@a.test' },
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-03-01T00:00:00.000Z',
    checklist: [],
    ...overrides,
  };
}

describe('myTaskGroup (DOCUMENT 04 C5)', () => {
  it('puts an open task due today first, whatever its status', () => {
    for (const status of ['not_started', 'in_progress', 'on_hold'] as const) {
      expect(myTaskGroup(task({ status, deadline: TODAY }), TODAY)).toBe('due_today');
    }
  });

  it('a completed or cancelled task due today goes by its status', () => {
    expect(myTaskGroup(task({ status: 'completed', deadline: TODAY }), TODAY)).toBe('completed');
    expect(myTaskGroup(task({ status: 'cancelled', deadline: TODAY }), TODAY)).toBe('cancelled');
  });

  it('uses the server’s overdue flag rather than recomputing it', () => {
    expect(
      myTaskGroup(task({ status: 'in_progress', deadline: '2026-03-09', is_overdue: true }), TODAY),
    ).toBe('overdue');
    // Same dates, but the server says not overdue: the server wins.
    expect(
      myTaskGroup(
        task({ status: 'in_progress', deadline: '2026-03-09', is_overdue: false }),
        TODAY,
      ),
    ).toBe('in_progress');
  });

  it('groups in DOCUMENT 04 C5 order and drops empty groups', () => {
    const groups = groupMyTasks(
      [
        task({ id: 'a', status: 'completed' }),
        task({ id: 'b', status: 'not_started' }),
        task({ id: 'c', status: 'in_progress', deadline: TODAY }),
        task({ id: 'd', status: 'in_progress', is_overdue: true, deadline: '2026-03-01' }),
        task({ id: 'e', status: 'in_progress' }),
      ],
      TODAY,
    );
    expect(groups.map((g) => g.group)).toEqual([
      'due_today',
      'overdue',
      'in_progress',
      'not_started',
      'completed',
    ]);
    expect(groups.flatMap((g) => g.tasks.map((t) => t.id))).toEqual(['c', 'd', 'e', 'b', 'a']);
  });

  it('keeps on-hold and cancelled tasks visible in their own groups', () => {
    const groups = groupMyTasks(
      [task({ status: 'on_hold' }), task({ status: 'cancelled' })],
      TODAY,
    );
    expect(groups.map((g) => g.group)).toEqual(['on_hold', 'cancelled']);
  });
});

describe('applyTick — the optimistic checklist (DOCUMENT 04 C6)', () => {
  const four = task({
    checklist: ['a', 'b', 'c', 'd'].map((id, position) => ({
      id,
      title: id,
      is_completed: false,
      completed_at: null,
      completed_by: null,
      position,
    })),
    checklist_total: 4,
  });

  it('shows the new progress and starts a not-started task on the first tick', () => {
    const next = applyTick(four, 'a', true);
    expect(next.progress_percent).toBe('25.00');
    expect(next.checklist_completed).toBe(1);
    expect(next.status).toBe('in_progress');
    expect(four.checklist[0]?.is_completed).toBe(false); // the original is untouched, for rollback
  });

  it('an untick lowers progress and never changes status', () => {
    const ticked = applyTick(applyTick(four, 'a', true), 'b', true);
    const next = applyTick({ ...ticked, status: 'on_hold' }, 'a', false);
    expect(next.progress_percent).toBe('25.00');
    expect(next.status).toBe('on_hold');
  });
});

describe('transitions as buttons (DOCUMENT 13 rule 4)', () => {
  it('names the same target by where it comes from', () => {
    expect(transitionAction('not_started', 'in_progress')).toBe('start');
    expect(transitionAction('on_hold', 'in_progress')).toBe('resume');
    expect(transitionAction('completed', 'in_progress')).toBe('reopen');
    expect(transitionAction('in_progress', 'completed')).toBe('complete');
    expect(transitionAction('in_progress', 'on_hold')).toBe('hold');
    expect(transitionAction('on_hold', 'cancelled')).toBe('cancel');
  });

  it('asks for a reason to cancel or reopen, and for nothing else', () => {
    const asks: string[] = [];
    const pairs: [TaskStatus, TaskStatus][] = [
      ['not_started', 'in_progress'],
      ['not_started', 'cancelled'],
      ['in_progress', 'completed'],
      ['in_progress', 'on_hold'],
      ['on_hold', 'in_progress'],
      ['on_hold', 'cancelled'],
      ['completed', 'in_progress'],
    ];
    for (const [from, to] of pairs) {
      if (needsReason(from, to)) asks.push(`${from}→${to}`);
    }
    expect(asks).toEqual(['not_started→cancelled', 'on_hold→cancelled', 'completed→in_progress']);
  });
});

describe('filters in the URL (DOCUMENT 11 §6)', () => {
  it('round-trips every filter and omits defaults', () => {
    const filters = {
      ...EMPTY_TASK_FILTERS,
      view: 'board' as const,
      status: 'in_progress',
      priority: 'urgent',
      assignee: '0190f0e2-0000-7000-8000-000000000001',
      department: '0190f0e2-0000-7000-8000-000000000002',
      overdue: true,
      from: '2026-03-01',
      to: '2026-03-31',
      page: 3,
    };
    const search = searchForTaskFilters(filters);
    expect(taskFiltersFromParams(new URLSearchParams(search.slice(1)))).toEqual(filters);
    expect(searchForTaskFilters(EMPTY_TASK_FILTERS)).toBe('');
  });

  it('drops values the API would refuse rather than sending them', () => {
    const filters = taskFiltersFromParams(
      new URLSearchParams(
        'status=overdue&priority=critical&assignee=x&from=2026-3-1&page=-2&view=grid',
      ),
    );
    expect(filters).toEqual(EMPTY_TASK_FILTERS);
    expect(hasActiveTaskFilters(filters)).toBe(false);
    expect(activeTaskFilterCount(filters)).toBe(0);
    expect(
      activeTaskFilterCount({ ...EMPTY_TASK_FILTERS, overdue: true, status: 'on_hold', page: 4 }),
    ).toBe(2);
  });

  it('builds the DOCUMENT 08 §4.7 query, never with a company id', () => {
    const query = apiQueryForTaskFilters(
      { ...EMPTY_TASK_FILTERS, overdue: true, assignee: 'a', page: 2 },
      20,
    );
    expect(query).toEqual({
      page: '2',
      per_page: '20',
      overdue: 'true',
      assignee_employee_id: 'a',
    });
    expect(Object.keys(query)).not.toContain('company_id');
  });

  it('a board column asks for its own status and always the first page', () => {
    const query = apiQueryForTaskFilters(
      { ...EMPTY_TASK_FILTERS, view: 'board', page: 4 },
      100,
      'on_hold',
    );
    expect(query).toMatchObject({ page: '1', per_page: '100', status: 'on_hold' });
  });
});

describe('small helpers', () => {
  it('reads progress strings safely', () => {
    expect(progressValue('66.67')).toBe(66.67);
    expect(progressValue('nope')).toBe(0);
    expect(progressValue('120')).toBe(100);
    expect(formatPercent('75.00')).toBe('75');
    expect(formatPercent('12.50')).toBe('12.5');
    expect(formatPercent('33.33')).toBe('33.33');
  });

  it('moves checklist builder items, ignoring out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, 5)).toEqual(['a', 'b', 'c']);
  });

  it('computes today in the company’s zone, not the browser’s', () => {
    // 23:30 UTC on 9 March is already 10 March in Cairo (UTC+2).
    const instant = new Date('2026-03-09T23:30:00.000Z');
    expect(todayIn('Africa/Cairo', instant)).toBe('2026-03-10');
    expect(todayIn('UTC', instant)).toBe('2026-03-09');
  });
});

describe('the employee profile’s Tasks tab (DOCUMENT 04 B4)', () => {
  it('keeps its filters under its own keys, leaving the profile’s alone', () => {
    const params = new URLSearchParams('notice=saved&history_page=2');
    const search = searchForEmployeeTaskFilters(params, {
      status: 'in_progress',
      priority: 'high',
      overdue: true,
      page: 2,
    });
    const back = new URLSearchParams(search.slice(1));
    expect(back.get('notice')).toBe('saved');
    expect(back.get('history_page')).toBe('2');
    expect(employeeTaskFiltersFromParams(back)).toEqual({
      status: 'in_progress',
      priority: 'high',
      overdue: true,
      page: 2,
    });
    // Clearing removes only this tab's keys.
    expect(searchForEmployeeTaskFilters(back, EMPTY_EMPLOYEE_TASK_FILTERS)).toBe(
      '?notice=saved&history_page=2',
    );
  });

  it('ignores values the API would refuse', () => {
    expect(
      employeeTaskFiltersFromParams(new URLSearchParams('task_status=overdue&task_page=0')),
    ).toEqual(EMPTY_EMPLOYEE_TASK_FILTERS);
  });

  it('always names the employee, and never a company', () => {
    const query = apiQueryForEmployeeTasks(
      'emp-1',
      { ...EMPTY_EMPLOYEE_TASK_FILTERS, overdue: true },
      20,
    );
    expect(query).toEqual({
      assignee_employee_id: 'emp-1',
      page: '1',
      per_page: '20',
      overdue: 'true',
    });
  });

  it('links "Assign task" to the form with the assignee chosen', () => {
    expect(newTaskPath('ar', 'emp-1')).toBe('/ar/admin/tasks/new?assignee=emp-1');
    expect(newTaskPath('en')).toBe('/en/admin/tasks/new');
  });
});
