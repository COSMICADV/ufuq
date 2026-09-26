import { describe, expect, it } from 'vitest';

import { isPermissionKey } from './permissions.js';
import {
  ASSIGNABLE_ROLE_KEYS,
  isAssignableRoleKey,
  isSystemRoleKey,
  permissionsForRole,
  ROLE_PERMISSIONS,
  SYSTEM_ROLES,
} from './roles.js';

describe('assignable roles — DOCUMENT 02 §7', () => {
  it('lets a company assign every system role except super_admin', () => {
    expect([...ASSIGNABLE_ROLE_KEYS]).toEqual(['admin', 'manager', 'employee']);
    expect(isAssignableRoleKey('super_admin')).toBe(false);
  });

  it('only ever names real system roles', () => {
    for (const key of ASSIGNABLE_ROLE_KEYS) {
      expect(isSystemRoleKey(key)).toBe(true);
    }
  });

  it.each(['', 'Admin', 'hr', 'owner'])('rejects %s', (value) => {
    expect(isAssignableRoleKey(value)).toBe(false);
  });
});

describe('roles — catalogue integrity', () => {
  it('defines exactly the four V1 roles, in the DOCUMENT 02 §2 order', () => {
    expect(SYSTEM_ROLES.map((r) => r.key)).toEqual(['super_admin', 'admin', 'manager', 'employee']);
  });

  it('gives every role a bilingual name', () => {
    for (const role of SYSTEM_ROLES) {
      expect(role.nameEn.length).toBeGreaterThan(0);
      expect(role.nameAr.length).toBeGreaterThan(0);
    }
  });

  it('grants super_admin nothing from the V1 catalogue (DOCUMENT 02 §7)', () => {
    expect(permissionsForRole('super_admin').size).toBe(0);
  });

  it('every grant references a real permission key', () => {
    for (const grant of ROLE_PERMISSIONS) {
      expect(isPermissionKey(grant.permission)).toBe(true);
    }
  });

  it('has no duplicate role+permission grant', () => {
    const seen = new Set<string>();
    for (const grant of ROLE_PERMISSIONS) {
      const key = `${grant.role}:${grant.permission}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe('roles — DOCUMENT 02 §4 spot checks', () => {
  it('ADMIN holds employee.view at company scope', () => {
    expect(permissionsForRole('admin').get('employee.view')).toBe('company');
  });

  it('MANAGER holds employee.view at team scope, not company', () => {
    expect(permissionsForRole('manager').get('employee.view')).toBe('team');
  });

  it('EMPLOYEE holds employee.view at self scope only', () => {
    expect(permissionsForRole('employee').get('employee.view')).toBe('self');
  });

  it('MANAGER never holds employee.view_salary — OD-07 V1 default', () => {
    expect(permissionsForRole('manager').has('employee.view_salary')).toBe(false);
  });

  it('EMPLOYEE holds employee.view_salary at self scope only', () => {
    expect(permissionsForRole('employee').get('employee.view_salary')).toBe('self');
  });

  it('only ADMIN can finalize payroll', () => {
    expect(permissionsForRole('admin').get('payroll.finalize')).toBe('company');
    expect(permissionsForRole('manager').has('payroll.finalize')).toBe(false);
    expect(permissionsForRole('employee').has('payroll.finalize')).toBe(false);
  });

  it('EMPLOYEE cannot edit goal progress — self-reporting is disallowed by design', () => {
    expect(permissionsForRole('employee').has('goal.update_progress')).toBe(false);
  });

  it('warehouse access is ADMIN-only in V1', () => {
    expect(permissionsForRole('admin').get('warehouse.view')).toBe('company');
    expect(permissionsForRole('manager').has('warehouse.view')).toBe(false);
    expect(permissionsForRole('employee').has('warehouse.view')).toBe(false);
  });

  it('audit.view is ADMIN-only', () => {
    expect(permissionsForRole('admin').get('audit.view')).toBe('company');
    expect(permissionsForRole('manager').has('audit.view')).toBe(false);
    expect(permissionsForRole('employee').has('audit.view')).toBe(false);
  });
});
