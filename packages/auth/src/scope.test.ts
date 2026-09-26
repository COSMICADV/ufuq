import { describe, expect, it } from 'vitest';

import { resolveScope, ScopeResolutionError } from './scope.js';

describe('resolveScope — DOCUMENT 09 §4', () => {
  it('resolves company scope with no employee record required', () => {
    expect(resolveScope('company', { callerEmployeeId: null })).toEqual({ kind: 'company' });
  });

  it('resolves platform scope unconditionally', () => {
    expect(resolveScope('platform', { callerEmployeeId: null })).toEqual({ kind: 'platform' });
  });

  it('resolves self scope to the caller employee id', () => {
    expect(resolveScope('self', { callerEmployeeId: 'emp-1' })).toEqual({
      kind: 'self',
      employeeId: 'emp-1',
    });
  });

  it('resolves team scope to the caller as the manager', () => {
    expect(resolveScope('team', { callerEmployeeId: 'emp-1' })).toEqual({
      kind: 'team',
      managerEmployeeId: 'emp-1',
    });
  });

  it('refuses self scope without an employee record rather than silently widening it', () => {
    expect(() => resolveScope('self', { callerEmployeeId: null })).toThrow(ScopeResolutionError);
  });

  it('refuses team scope without an employee record', () => {
    expect(() => resolveScope('team', { callerEmployeeId: null })).toThrow(ScopeResolutionError);
  });
});
