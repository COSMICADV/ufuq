/**
 * Declares the permission an endpoint requires — DOCUMENT 02 §5.1: "Every
 * protected endpoint declares its required permission. No endpoint is
 * protected only by 'the button isn't rendered'."
 *
 * No Phase 3 endpoint uses this yet — DOCUMENT 08 §4.1's authentication
 * endpoints require only that the caller is authenticated, not a specific
 * permission. It exists now, tested, so Phase 4's first `settings.view`
 * endpoint is a one-line addition rather than new guard machinery.
 */

import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@ufuq/auth';

export const REQUIRED_PERMISSION_KEY = 'ufuq:requiredPermission';

export const RequirePermission = (permission: PermissionKey): ReturnType<typeof SetMetadata> =>
  SetMetadata(REQUIRED_PERMISSION_KEY, permission);
