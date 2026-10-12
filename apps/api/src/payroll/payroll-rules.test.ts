/**
 * The payroll state machine and access rules — DOCUMENT 15 "PAYROLL STATES",
 * OD-07 A. Every action is tried from every state; only the documented
 * transitions pass.
 */

import { describe, expect, it } from 'vitest';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';

import {
  assertAllowed,
  isAllowed,
  nextStatus,
  PERIOD_STATUSES,
  payrollReach,
  periodLabel,
} from './payroll-rules.js';
import type { PeriodAction, PeriodStatus } from './payroll-rules.js';

const ALLOWED: Record<PeriodAction, readonly PeriodStatus[]> = {
  recalculate: ['draft'],
  submit_review: ['draft'],
  approve: ['under_review'],
  return_to_draft: ['under_review'],
  return_to_review: ['approved'],
  finalize: ['approved'],
  mark_paid: ['finalized', 'adjusted'],
  add_entry: ['draft', 'under_review'],
  adjust: ['finalized', 'paid', 'adjusted'],
};

describe('the state machine', () => {
  for (const [action, from] of Object.entries(ALLOWED) as [PeriodAction, PeriodStatus[]][]) {
    it(`${action}: allowed exactly from ${from.join(', ')}`, () => {
      for (const status of PERIOD_STATUSES) {
        expect(isAllowed(action, status)).toBe(from.includes(status));
        if (!from.includes(status)) {
          expect(() => assertAllowed(action, status)).toThrow(AppException);
        }
      }
    });
  }

  it('moves forward as documented', () => {
    expect(nextStatus('submit_review', 'draft')).toBe('under_review');
    expect(nextStatus('approve', 'under_review')).toBe('approved');
    expect(nextStatus('return_to_draft', 'under_review')).toBe('draft');
    expect(nextStatus('return_to_review', 'approved')).toBe('under_review');
    expect(nextStatus('finalize', 'approved')).toBe('finalized');
    expect(nextStatus('mark_paid', 'finalized')).toBe('paid');
    expect(nextStatus('adjust', 'finalized')).toBe('adjusted');
    expect(nextStatus('adjust', 'paid')).toBe('adjusted');
  });

  it('an adjusted period not yet paid may be marked paid once, staying adjusted', () => {
    expect(isAllowed('mark_paid', 'adjusted', null)).toBe(true);
    expect(nextStatus('mark_paid', 'adjusted')).toBe('adjusted');
    expect(isAllowed('mark_paid', 'adjusted', new Date())).toBe(false);
    expect(isAllowed('mark_paid', 'paid')).toBe(false);
  });

  it('names the reason: a locked line, a finalized period, or an invalid transition', () => {
    const code = (run: () => void): string => {
      try {
        run();
      } catch (error) {
        return (error as AppException).appErrorCode;
      }
      return 'none';
    };
    expect(code(() => assertAllowed('add_entry', 'finalized'))).toBe('PAYROLL_LINE_LOCKED');
    expect(code(() => assertAllowed('recalculate', 'paid'))).toBe('PAYROLL_PERIOD_FINALIZED');
    expect(code(() => assertAllowed('finalize', 'draft'))).toBe('PAYROLL_INVALID_TRANSITION');
    expect(code(() => assertAllowed('add_entry', 'approved'))).toBe('PAYROLL_INVALID_TRANSITION');
  });

  it('labels a period as the YYYY-MM the finalization confirmation types', () => {
    expect(periodLabel(2026, 3)).toBe('2026-03');
    expect(periodLabel(2026, 11)).toBe('2026-11');
  });
});

describe('who reaches payroll (OD-07 A)', () => {
  const caller = (
    scope: string | undefined,
  ): Pick<AuthContext, 'permissions' | 'callerEmployeeId'> => ({
    permissions: new Map(scope === undefined ? [] : [['payroll.view', scope as never]]),
    callerEmployeeId: 'e-1',
  });

  it('company for ADMIN, self for EMPLOYEE, nothing for MANAGER or a team scope', () => {
    expect(payrollReach(caller('company'), 'payroll.view')).toEqual({ kind: 'company' });
    expect(payrollReach(caller('self'), 'payroll.view')).toEqual({
      kind: 'self',
      employeeId: 'e-1',
    });
    expect(() => payrollReach(caller(undefined), 'payroll.view')).toThrow(AppException);
    expect(() => payrollReach(caller('team'), 'payroll.view')).toThrow(AppException);
  });
});
