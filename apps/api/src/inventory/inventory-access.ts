/**
 * ADMIN only in V1 (DOCUMENT 17 "Users", DOCUMENT 02): every inventory call
 * needs its permission at company scope. MANAGER and EMPLOYEE hold none of
 * the product, stock or warehouse permissions, so they are refused here,
 * server-side, whatever the client shows.
 */

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

export function requireCompany(ctx: AuthContext, permission: string): void {
  const scope = ctx.permissions.get(permission);
  if (scope !== 'company' && scope !== 'platform') {
    throw new AppException(ERROR_CODES.FORBIDDEN, 403);
  }
}
