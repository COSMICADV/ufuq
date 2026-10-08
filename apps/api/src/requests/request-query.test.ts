/**
 * The Requests Centre's scope rules — DOCUMENT 02 "Requests", DOCUMENT 09 §4,
 * OD-03 — without a database.
 */

import type { PermissionScope } from '@ufuq/auth';
import { describe, expect, it } from 'vitest';

import { AppException } from '../common/app-exception.js';

import {
  canReview,
  requestReviewableWhere,
  requestScopeWhere,
  requestVisibleWhere,
} from './request-query.js';
import {
  isNativeCategory,
  isOpen,
  NATIVE_CATEGORIES,
  REQUEST_CATEGORIES,
} from './request-rules.js';

const ME = '00000000-0000-7000-8000-000000000001';

function caller(grants: Record<string, PermissionScope>, employeeId: string | null = ME) {
  return { permissions: new Map(Object.entries(grants)), callerEmployeeId: employeeId };
}

const EMPLOYEE = caller({
  'request.create': 'self',
  'request.view': 'self',
  'request.cancel': 'self',
});
const MANAGER = caller({ 'request.view': 'team', 'request.review': 'team' });
const ADMIN = caller({ 'request.view': 'company', 'request.review': 'company' });

describe('scope', () => {
  it('self, team and company resolve as DOCUMENT 02 says', () => {
    expect(requestScopeWhere(EMPLOYEE, 'request.view')).toEqual({ employeeId: ME });
    expect(requestScopeWhere(MANAGER, 'request.view')).toEqual({ employee: { managerId: ME } });
    expect(requestScopeWhere(ADMIN, 'request.view')).toEqual({});
  });

  it('a missing permission, or self scope with no employee record, is refused — never widened', () => {
    expect(() => requestScopeWhere(EMPLOYEE, 'request.review')).toThrow(AppException);
    expect(() =>
      requestScopeWhere(caller({ 'request.view': 'self' }, null), 'request.view'),
    ).toThrow(AppException);
  });

  it('visibility adds the caller’s own requests to their scope', () => {
    expect(requestVisibleWhere(MANAGER)).toEqual({
      OR: [{ employee: { managerId: ME } }, { employeeId: ME }],
    });
    expect(requestVisibleWhere(caller({ 'request.view': 'company' }, null))).toEqual({});
    // An ADMIN who is also an employee: company scope already covers their own.
    expect(requestVisibleWhere(ADMIN)).toEqual({});
    expect(() => requestVisibleWhere(caller({}, null))).toThrow(AppException);
  });
});

describe('OD-03 — review never reaches the reviewer’s own request', () => {
  it('a company-scoped admin with an employee record excludes themselves', () => {
    expect(requestReviewableWhere(ADMIN)).toEqual({
      AND: [{}, { employeeId: { not: ME } }],
    });
  });

  it('a manager’s team scope, too, is narrowed explicitly', () => {
    expect(requestReviewableWhere(MANAGER)).toEqual({
      AND: [{ employee: { managerId: ME } }, { employeeId: { not: ME } }],
    });
  });

  it('only a reviewer can review', () => {
    expect(canReview(ADMIN)).toBe(true);
    expect(canReview(MANAGER)).toBe(true);
    expect(canReview(EMPLOYEE)).toBe(false);
    expect(canReview(caller({ 'request.review': 'team' }, null))).toBe(false);
  });
});

describe('the OD-09 split and terminal states', () => {
  it('salary, task and general are native; attendance and leave are specialised', () => {
    expect(REQUEST_CATEGORIES.filter(isNativeCategory)).toEqual([...NATIVE_CATEGORIES]);
    expect(isNativeCategory('attendance')).toBe(false);
    expect(isNativeCategory('leave')).toBe(false);
  });

  it('only pending is open', () => {
    expect(isOpen('pending')).toBe(true);
    for (const status of ['approved', 'rejected', 'cancelled'] as const) {
      expect(isOpen(status)).toBe(false);
    }
  });
});
