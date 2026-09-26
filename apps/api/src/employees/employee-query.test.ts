import { permissionsForRole } from '@ufuq/auth';
import { describe, expect, it } from 'vitest';

import { AppException } from '../common/app-exception.js';

import {
  employeeScopeWhere,
  filterWhere,
  listWhere,
  MAX_SEARCH_TERMS,
  orderByFor,
  searchWhere,
} from './employee-query.js';

const CALLER = '0192f7a0-0000-7000-8000-00000000c011';

function ctx(role: 'admin' | 'manager' | 'employee', callerEmployeeId: string | null = CALLER) {
  return { permissions: permissionsForRole(role), callerEmployeeId };
}

function forbiddenStatus(run: () => unknown): number | null {
  try {
    run();
  } catch (error) {
    return error instanceof AppException ? error.getStatus() : null;
  }
  return null;
}

describe('employeeScopeWhere — DOCUMENT 09 §4 ownership scope as a query constraint', () => {
  it('adds nothing for an ADMIN (company scope; row-level security is the tenant scope)', () => {
    expect(employeeScopeWhere(ctx('admin', null), 'employee.view')).toEqual({});
  });

  it('limits a MANAGER to employees whose manager they are (team)', () => {
    expect(employeeScopeWhere(ctx('manager'), 'employee.view')).toEqual({ managerId: CALLER });
  });

  it('limits an EMPLOYEE to their own row (self)', () => {
    expect(employeeScopeWhere(ctx('employee'), 'employee.view')).toEqual({ id: CALLER });
  });

  it('refuses a scoped role with no employee record rather than widening the scope', () => {
    expect(forbiddenStatus(() => employeeScopeWhere(ctx('manager', null), 'employee.view'))).toBe(
      403,
    );
  });

  it('refuses a permission the role does not hold', () => {
    expect(forbiddenStatus(() => employeeScopeWhere(ctx('manager'), 'employee.update'))).toBe(403);
  });
});

describe('listWhere', () => {
  it('AND-s the scope with the filters, so a filter can narrow but never widen it', () => {
    const where = listWhere(ctx('manager'), { manager_id: '0192f7a0-0000-7000-8000-00000000beef' });
    expect(where).toEqual({
      AND: [
        { deletedAt: null },
        { managerId: CALLER },
        { managerId: '0192f7a0-0000-7000-8000-00000000beef' },
        {},
      ],
    });
  });
});

describe('filterWhere — DOCUMENT 08 §4.3 filters', () => {
  it('maps only the filters that were given', () => {
    expect(filterWhere({})).toEqual({});
    expect(filterWhere({ status: 'inactive', department_id: 'd' })).toEqual({
      status: 'inactive',
      departmentId: 'd',
    });
  });
});

describe('searchWhere — name, code, email', () => {
  it('matches every word against any searchable column, case-insensitively', () => {
    expect(searchWhere('سارة EMP')).toEqual({
      AND: ['سارة', 'EMP'].map((term) => ({
        OR: [
          { firstName: { contains: term, mode: 'insensitive' } },
          { lastName: { contains: term, mode: 'insensitive' } },
          { employeeCode: { contains: term, mode: 'insensitive' } },
          { email: { contains: term, mode: 'insensitive' } },
        ],
      })),
    });
  });

  it('ignores blank searches and caps the number of words', () => {
    expect(searchWhere(undefined)).toEqual({});
    expect(searchWhere('   ')).toEqual({});
    const many = searchWhere('a b c d e f g h') as { AND: unknown[] };
    expect(many.AND).toHaveLength(MAX_SEARCH_TERMS);
  });
});

describe('orderByFor — DOCUMENT 08 §4.3 sort whitelist', () => {
  it('always ends in a stable tiebreak on id', () => {
    for (const sort of ['name', 'joining_date', 'department'] as const) {
      const order = orderByFor(sort, 'desc', 'ar');
      expect(order[order.length - 1]).toEqual({ id: 'asc' });
    }
  });

  it('sorts departments by the name the reader sees', () => {
    expect(orderByFor('department', 'asc', 'ar')[0]).toEqual({ department: { nameAr: 'asc' } });
    expect(orderByFor('department', 'asc', 'en')[0]).toEqual({ department: { nameEn: 'asc' } });
  });
});
