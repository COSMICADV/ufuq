/**
 * DOCUMENT 09 §4 check 3 (PERMISSION) — DOCUMENT 02 §5.1: every endpoint
 * that declares `@RequirePermission(...)` is denied with 403 unless the
 * caller's role grants that permission (DOCUMENT 20 §2: server-side, on
 * every request, never decorative).
 *
 * This does not resolve DOCUMENT 09 §4 check 4 (OWNERSHIP SCOPE) — that is
 * `resolveScope` (`@ufuq/auth`), applied by the service that knows what kind
 * of row it is fetching. No Phase 3 endpoint has a scoped resource to apply
 * it to; this guard is what a Phase 4+ endpoint adds `@RequirePermission`
 * to and gets check 3 for free.
 */

import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@ufuq/auth';

import { REQUIRED_PERMISSION_KEY } from '../decorators/permissions.decorator.js';
import type { Request } from 'express';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const authContext = request.authContext;
    if (!authContext?.permissions.has(required)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
