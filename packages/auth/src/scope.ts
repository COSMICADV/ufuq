/**
 * Ownership scope resolution — DOCUMENT 09 §4.
 *
 * A permission grant is not enough on its own: `attendance.view` at `team`
 * scope does not permit viewing another department's attendance. Scope is
 * resolved into a query constraint *before* fetching — never as a post-fetch
 * filter (DOCUMENT 02 §5.3, DOCUMENT 20 §2).
 *
 * `self` and `team` require the caller to have an `employee_id` bound to
 * their session. No business module has an `employees` table yet (that is
 * Phase 5), so every Phase 3 caller resolves those scopes as
 * {@link ScopeResolutionError} — the function is exercised by the first
 * scoped endpoint, not by Phase 3 itself.
 */

import type { PermissionScope } from './roles.js';

export interface ScopeContext {
  /** Null until the caller has an employee record (Phase 5). */
  readonly callerEmployeeId: string | null;
}

export type ScopeConstraint =
  | { readonly kind: 'self'; readonly employeeId: string }
  | { readonly kind: 'team'; readonly managerEmployeeId: string }
  | { readonly kind: 'company' }
  | { readonly kind: 'platform' };

export class ScopeResolutionError extends Error {
  constructor(scope: PermissionScope) {
    super(`Scope "${scope}" requires the caller to have an employee record.`);
    this.name = 'ScopeResolutionError';
  }
}

export function resolveScope(scope: PermissionScope, context: ScopeContext): ScopeConstraint {
  switch (scope) {
    case 'self': {
      if (context.callerEmployeeId === null) {
        throw new ScopeResolutionError(scope);
      }
      return { kind: 'self', employeeId: context.callerEmployeeId };
    }
    case 'team': {
      if (context.callerEmployeeId === null) {
        throw new ScopeResolutionError(scope);
      }
      return { kind: 'team', managerEmployeeId: context.callerEmployeeId };
    }
    case 'company':
      return { kind: 'company' };
    case 'platform':
      return { kind: 'platform' };
  }
}
