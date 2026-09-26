/**
 * The employees screens' pure logic — DOCUMENT 03 §3, DOCUMENT 04 B2–B4 and A4,
 * DOCUMENT 11 §6.
 */

import { ASSIGNABLE_ROLE_KEYS, MIN_PASSWORD_LENGTH } from '@ufuq/auth';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api-client';
import {
  acceptanceIssues,
  activeFilterCount,
  apiQueryForListParams,
  ASSIGNABLE_ROLES,
  canInvite,
  clearedFilters,
  createBody,
  DEFAULT_LIST_PARAMS,
  editEmployeePath,
  EMPLOYEE_TABS,
  employeeIssueKey,
  employeePath,
  employeesPath,
  emptyEmployeeForm,
  formFromEmployee,
  fullName,
  initials,
  invitationState,
  isDirty,
  listParamsFromSearch,
  newEmployeePath,
  PASSWORD_MIN_LENGTH,
  passwordLengthOk,
  searchForListParams,
  statusTone,
  tokenFromHash,
  updateBody,
  visibleTabs,
} from './employees';
import type { EmployeeView } from './employees';

const ID = '0192f7a0-0000-7000-8000-000000000001';
const DEPT = '0192f7a0-0000-7000-8000-0000000000d1';

function employee(overrides: Partial<EmployeeView> = {}): EmployeeView {
  return {
    id: ID,
    employee_code: 'EMP-0042',
    first_name: 'سارة',
    last_name: 'أحمد',
    photo_path: null,
    email: 'sara@company.test',
    phone: null,
    department: { id: DEPT, name_ar: 'التسويق', name_en: 'Marketing' },
    position: null,
    manager: null,
    work_schedule: { id: '0192f7a0-0000-7000-8000-0000000000e1', name: 'Standard' },
    joining_date: '2026-01-15',
    status: 'active',
    termination_date: null,
    account: { status: 'invited', role_key: 'employee', invitation_expires_at: null },
    ...overrides,
  };
}

describe('shared constants stay in step with @ufuq/auth', () => {
  it('offers exactly the roles a company may assign — DOCUMENT 02 §7', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual([...ASSIGNABLE_ROLE_KEYS]);
    expect(ASSIGNABLE_ROLES).not.toContain('super_admin');
  });

  it('hints the same minimum length the API enforces — DOCUMENT 09 §2', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(MIN_PASSWORD_LENGTH);
  });
});

describe('routes — DOCUMENT 03 §3', () => {
  it('builds the employee subtree with English segments in both locales', () => {
    expect(employeesPath('ar')).toBe('/ar/admin/employees');
    expect(newEmployeePath('en')).toBe('/en/admin/employees/new');
    expect(editEmployeePath('ar', ID)).toBe(`/ar/admin/employees/${ID}/edit`);
  });

  it('gives Overview the profile address and every other tab its own segment', () => {
    expect(employeePath('ar', ID)).toBe(`/ar/admin/employees/${ID}`);
    expect(employeePath('ar', ID, 'reports')).toBe(`/ar/admin/employees/${ID}/reports`);
  });

  it('has DOCUMENT 04 B4’s seven tabs in order', () => {
    expect([...EMPLOYEE_TABS]).toEqual([
      'overview',
      'attendance',
      'tasks',
      'goals',
      'salary',
      'requests',
      'reports',
    ]);
  });
});

describe('visibleTabs — DOCUMENT 04 B4 "tab visibility follows permissions"', () => {
  it('hides Salary from a caller without employee.view_salary', () => {
    const tabs = visibleTabs(
      new Set(['attendance.view', 'task.view', 'goal.view', 'request.view']),
    );
    expect(tabs).not.toContain('salary');
    expect(tabs).toContain('attendance');
  });

  it('always shows Overview', () => {
    expect(visibleTabs(new Set())).toEqual(['overview']);
  });

  it('shows all seven tabs to a caller holding every module permission', () => {
    const all = new Set([
      'attendance.view',
      'task.view',
      'goal.view',
      'employee.view_salary',
      'request.view',
      'report.employee_monthly',
    ]);
    expect(visibleTabs(all)).toHaveLength(7);
  });
});

describe('list state in the URL — DOCUMENT 11 §6', () => {
  it('reads every filter, and falls back on values the API would reject', () => {
    const params = listParamsFromSearch(
      new URLSearchParams(
        `page=3&search=sara&department_id=${DEPT}&status=inactive&sort=joining_date&order=desc`,
      ),
    );
    expect(params).toEqual({
      ...DEFAULT_LIST_PARAMS,
      page: 3,
      search: 'sara',
      department_id: DEPT,
      status: 'inactive',
      sort: 'joining_date',
      order: 'desc',
    });

    const hostile = listParamsFromSearch(
      new URLSearchParams('page=-2&department_id=not-a-uuid&status=fired&sort=salary&order=up'),
    );
    expect(hostile).toEqual(DEFAULT_LIST_PARAMS);
  });

  it('round-trips through the query string, omitting defaults', () => {
    const value = { ...DEFAULT_LIST_PARAMS, search: 'EMP', status: 'active' as const };
    const query = searchForListParams(value);
    expect(query).toBe('?search=EMP&status=active');
    expect(listParamsFromSearch(new URLSearchParams(query.slice(1)))).toEqual(value);
    expect(searchForListParams(DEFAULT_LIST_PARAMS)).toBe('');
  });

  it('sends only the filters that are set to the API', () => {
    expect(apiQueryForListParams({ ...DEFAULT_LIST_PARAMS, manager_id: ID }, 20)).toEqual({
      page: '1',
      per_page: '20',
      sort: 'name',
      order: 'asc',
      manager_id: ID,
    });
  });

  it('counts active filters but not the sort, and clears them keeping the sort', () => {
    const value = {
      ...DEFAULT_LIST_PARAMS,
      page: 4,
      search: ' x ',
      position_id: ID,
      sort: 'department' as const,
    };
    expect(activeFilterCount(value)).toBe(2);
    expect(clearedFilters(value)).toEqual({ ...DEFAULT_LIST_PARAMS, sort: 'department' });
  });
});

describe('the employee form — DOCUMENT 04 B3', () => {
  it('starts on the company default schedule, with no role chosen for the admin', () => {
    const form = emptyEmployeeForm('schedule-1');
    expect(form.work_schedule_id).toBe('schedule-1');
    expect(form.role_key).toBe('');
    expect(emptyEmployeeForm(null).work_schedule_id).toBe('');
  });

  it('turns empty optional fields into explicit nulls on create', () => {
    const body = createBody({
      ...emptyEmployeeForm('schedule-1'),
      first_name: 'Sara',
      role_key: 'employee',
    });
    expect(body['department_id']).toBeNull();
    expect(body['manager_id']).toBeNull();
    expect(body['phone']).toBeNull();
    expect(body['work_schedule_id']).toBe('schedule-1');
    expect(body).not.toHaveProperty('company_id');
  });

  it('sends only changed fields on update — an unchanged manager is not re-sent', () => {
    const initial = formFromEmployee(employee());
    expect(updateBody(initial, initial)).toEqual({});
    expect(isDirty(initial, initial)).toBe(false);

    const changed = { ...initial, department_id: '', first_name: 'Sarah' };
    expect(updateBody(initial, changed)).toEqual({ department_id: null, first_name: 'Sarah' });
    expect(isDirty(initial, changed)).toBe(true);
  });

  it('maps a manager cycle to its own message and unknown issues to "invalid"', () => {
    const error = new ApiError(422, {
      code: 'VALIDATION_FAILED',
      message_ar: '',
      message_en: '',
      fields: { manager_id: ['would_create_cycle'], email: ['already_taken'], phone: ['matches'] },
    });
    expect(employeeIssueKey('manager_id', error)).toBe('employees.manager_cycle');
    expect(employeeIssueKey('email', error)).toBe('validation.already_taken');
    expect(employeeIssueKey('phone', error)).toBe('validation.invalid');
    expect(employeeIssueKey('first_name', error)).toBeNull();
  });
});

describe('presentation', () => {
  it('builds names and initials in either script', () => {
    expect(fullName(employee())).toBe('سارة أحمد');
    expect(initials(employee())).toBe('سأ');
    expect(initials({ first_name: 'Sara', last_name: 'Ahmed' })).toBe('SA');
  });

  it('gives every status a tone', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('inactive')).toBe('cancelled');
    expect(statusTone('terminated')).toBe('danger');
  });

  it('describes the invitation state', () => {
    const now = new Date('2026-09-13T10:00:00Z');
    expect(invitationState(employee(), now)).toBe('not_sent');
    expect(
      invitationState(
        employee({
          account: {
            status: 'invited',
            role_key: 'employee',
            invitation_expires_at: '2026-09-15T10:00:00Z',
          },
        }),
        now,
      ),
    ).toBe('pending');
    expect(
      invitationState(
        employee({
          account: {
            status: 'invited',
            role_key: 'employee',
            invitation_expires_at: '2026-09-12T10:00:00Z',
          },
        }),
        now,
      ),
    ).toBe('expired');
    expect(
      invitationState(
        employee({
          account: { status: 'active', role_key: 'employee', invitation_expires_at: null },
        }),
        now,
      ),
    ).toBe('accepted');
    expect(invitationState(employee({ account: null }), now)).toBe('none');
  });

  it('offers a resend exactly when the API would accept one', () => {
    expect(canInvite(employee())).toBe(true);
    expect(canInvite(employee({ status: 'inactive' }))).toBe(false);
    expect(
      canInvite(
        employee({
          account: { status: 'active', role_key: 'employee', invitation_expires_at: null },
        }),
      ),
    ).toBe(false);
  });
});

describe('invitation acceptance — DOCUMENT 04 A4, DOCUMENT 20 §6', () => {
  it('reads the token from the fragment', () => {
    expect(tokenFromHash('#token=abc%2Fdef')).toBe('abc/def');
    expect(tokenFromHash('token=abc')).toBe('abc');
    expect(tokenFromHash('')).toBeNull();
    expect(tokenFromHash('#token=')).toBeNull();
  });

  it('checks the minimum length only as a hint', () => {
    expect(passwordLengthOk('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
    expect(passwordLengthOk('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });

  const good = 'a'.repeat(PASSWORD_MIN_LENGTH);

  it('lets a complete, agreed form through', () => {
    expect(acceptanceIssues({ password: good, confirmation: good, terms: true })).toEqual({});
  });

  it('refuses an activation whose terms box is unticked — DOCUMENT 04 A4', () => {
    expect(acceptanceIssues({ password: good, confirmation: good, terms: false })).toEqual({
      terms: 'required',
    });
  });

  it('reports every problem at once, so the invitee fixes them in one pass', () => {
    expect(acceptanceIssues({ password: 'short', confirmation: 'other', terms: false })).toEqual({
      password: 'too_short',
      confirmation: 'mismatch',
      terms: 'required',
    });
  });
});
