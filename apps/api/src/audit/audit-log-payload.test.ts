/**
 * DOCUMENT 21 "Captured with care": salary values in the audit viewer are
 * visible only to a caller who also holds `employee.view_salary`.
 */

import { describe, expect, it } from 'vitest';

import { actionFromWire, actionToWire, AUDIT_ACTION_VALUES } from './audit-actions.js';
import { auditLogPayload, REDACTED, redactSalary } from './audit-log-payload.js';
import type { AuditLogRow } from './audit-log-payload.js';

function row(oldValues: unknown, newValues: unknown): AuditLogRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    companyId: '00000000-0000-7000-8000-000000000002',
    userId: '00000000-0000-7000-8000-000000000003',
    action: 'EMPLOYEE_UPDATED',
    entityType: 'employee',
    entityId: '00000000-0000-7000-8000-000000000004',
    oldValues,
    newValues,
    ipAddress: null,
    userAgent: null,
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    user: {
      id: '00000000-0000-7000-8000-000000000003',
      email: 'admin@a.test',
      isSystem: false,
      employee: { firstName: 'Mona', lastName: 'Saleh' },
    },
  } as AuditLogRow;
}

describe('redactSalary', () => {
  it('withholds every salary-named field, at any depth, and nothing else', () => {
    expect(
      redactSalary({
        monthly_salary: '20000.00',
        first_name: 'Omar',
        nested: { base_salary: '1.00', note: 'x' },
        list: [{ Salary: 5 }],
      }),
    ).toEqual({
      monthly_salary: REDACTED,
      first_name: 'Omar',
      nested: { base_salary: REDACTED, note: 'x' },
      list: [{ Salary: REDACTED }],
    });
  });

  it('leaves scalars and null alone', () => {
    expect(redactSalary(null)).toBeNull();
    expect(redactSalary('salary')).toBe('salary');
  });
});

describe('auditLogPayload', () => {
  it('redacts salary for a caller without company-wide employee.view_salary', () => {
    const payload = auditLogPayload(row({ monthly_salary: '1' }, { monthly_salary: '2' }), {
      canViewSalary: false,
    });
    expect(payload.old_values).toEqual({ monthly_salary: REDACTED });
    expect(payload.new_values).toEqual({ monthly_salary: REDACTED });
  });

  it('shows salary to a caller who holds it', () => {
    const payload = auditLogPayload(row({ monthly_salary: '1' }, null), { canViewSalary: true });
    expect(payload.old_values).toEqual({ monthly_salary: '1' });
    expect(payload.new_values).toBeNull();
  });

  it('names the action as DOCUMENT 21 spells it, and the actor by name', () => {
    const payload = auditLogPayload(row(null, null), { canViewSalary: true });
    expect(payload.action).toBe('employee.updated');
    expect(payload.actor).toEqual({
      id: '00000000-0000-7000-8000-000000000003',
      name: 'Mona Saleh',
      email: 'admin@a.test',
      is_system: false,
    });
  });
});

describe('audit action names', () => {
  it('round-trip between DOCUMENT 21 spelling and the Prisma enum', () => {
    expect(AUDIT_ACTION_VALUES).toContain('attendance.generated_by_system');
    expect(AUDIT_ACTION_VALUES).toContain('logout');
    for (const value of AUDIT_ACTION_VALUES) {
      expect(actionToWire(actionFromWire(value))).toBe(value);
    }
  });
});
