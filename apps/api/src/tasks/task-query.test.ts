/**
 * Task scope and filters — DOCUMENT 02 "Tasks", DOCUMENT 09 §4, DOCUMENT 08
 * §4.7. The HTTP proof is `test/tasks.e2e.test.ts`; this pins the shape.
 */

import type { PermissionScope } from '@ufuq/auth';
import { describe, expect, it } from 'vitest';

import { AppException } from '../common/app-exception.js';

import {
  listWhere,
  needsReassignmentWhere,
  notOverdueWhere,
  overdueWhere,
  taskScopeWhere,
} from './task-query.js';

const caller = (scope: PermissionScope | undefined, callerEmployeeId: string | null = 'emp-1') => ({
  permissions: new Map<string, PermissionScope>(scope === undefined ? [] : [['task.view', scope]]),
  callerEmployeeId,
});

describe('taskScopeWhere', () => {
  it('self is the tasks assigned to the caller', () => {
    expect(taskScopeWhere(caller('self'), 'task.view')).toEqual({ assigneeEmployeeId: 'emp-1' });
  });

  it('team is the tasks assigned to the caller’s reports', () => {
    expect(taskScopeWhere(caller('team'), 'task.view')).toEqual({
      assignee: { managerId: 'emp-1' },
    });
  });

  it('company adds nothing beyond the tenant scope', () => {
    expect(taskScopeWhere(caller('company', null), 'task.view')).toEqual({});
  });

  it('refuses a caller without the permission, and a self/team caller with no employee record', () => {
    expect(() => taskScopeWhere(caller(undefined), 'task.view')).toThrow(AppException);
    expect(() => taskScopeWhere(caller('self', null), 'task.view')).toThrow(AppException);
    expect(() => taskScopeWhere(caller('team', null), 'task.view')).toThrow(AppException);
  });
});

describe('listWhere', () => {
  it('always excludes soft-deleted tasks and AND-s the scope with every filter', () => {
    const where = listWhere(
      { assigneeEmployeeId: 'emp-1' },
      {
        status: 'in_progress',
        priority: 'high',
        assignee_employee_id: 'emp-2',
        department_id: 'dep-1',
        from: '2026-03-01',
        to: '2026-03-31',
      },
      '2026-03-10',
    );
    expect(where.AND).toEqual([
      { deletedAt: null },
      { assigneeEmployeeId: 'emp-1' },
      { status: 'in_progress' },
      { priority: 'high' },
      { assigneeEmployeeId: 'emp-2' },
      { departmentId: 'dep-1' },
      { deadline: { gte: new Date('2026-03-01T00:00:00.000Z') } },
      { deadline: { lte: new Date('2026-03-31T00:00:00.000Z') } },
    ]);
  });

  it('overdue=true is a past deadline on an open task; false includes undated and closed tasks', () => {
    expect(overdueWhere('2026-03-10')).toEqual({
      deadline: { lt: new Date('2026-03-10T00:00:00.000Z') },
      status: { in: ['not_started', 'in_progress', 'on_hold'] },
    });
    expect(notOverdueWhere('2026-03-10')).toEqual({
      OR: [
        { deadline: null },
        { deadline: { gte: new Date('2026-03-10T00:00:00.000Z') } },
        { status: { in: ['completed', 'cancelled'] } },
      ],
    });
    expect(listWhere({}, { overdue: 'true' }, '2026-03-10').AND).toContainEqual(
      overdueWhere('2026-03-10'),
    );
    expect(listWhere({}, { overdue: 'false' }, '2026-03-10').AND).toContainEqual(
      notOverdueWhere('2026-03-10'),
    );
  });
});

describe('needsReassignmentWhere (DOCUMENT 13 edge case)', () => {
  it('is an open task whose assignee is not active, AND-ed with the scope', () => {
    expect(needsReassignmentWhere()).toEqual({
      status: { in: ['not_started', 'in_progress', 'on_hold'] },
      assignee: { OR: [{ status: { not: 'active' } }, { deletedAt: { not: null } }] },
    });
    const where = listWhere(
      { assignee: { managerId: 'emp-1' } },
      { needs_reassignment: 'true' },
      '2026-03-10',
    );
    expect(where.AND).toEqual([
      { deletedAt: null },
      { assignee: { managerId: 'emp-1' } },
      needsReassignmentWhere(),
    ]);
  });
});
