import type { PermissionScope } from '@ufuq/auth';

/**
 * What `SessionAuthGuard` attaches to every authenticated request —
 * DOCUMENT 09 §4's four checks read from this and nothing else.
 *
 * `callerEmployeeId` is always null in Phase 3: there is no `employees`
 * table yet (DOCUMENT 25 Phase 5). It exists on this type now so
 * `resolveScope` (`@ufuq/auth`) and the endpoints that will call it in later
 * phases do not need this type to change shape under them.
 */
export interface AuthContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly permissions: ReadonlyMap<string, PermissionScope>;
  readonly clientType: 'web' | 'mobile';
  readonly callerEmployeeId: string | null;
}

declare module 'express' {
  interface Request {
    authContext?: AuthContext;
  }
}
