/**
 * Guards the platform owner's sign-up review API. The owner is not a tenant
 * user, so there is no session: every request carries the owner key
 * (`OWNER_ACCESS_KEY`) in the `x-owner-key` header. A header — not a cookie —
 * so a cross-site request cannot attach it, and the CSRF check has nothing to
 * protect. Wrong keys are rate limited per IP; with no key configured the API
 * answers 404, as if it did not exist.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import { timingSafeEqualStrings } from '@ufuq/auth';
import type { Request } from 'express';

import { APP_ENV } from '../app.tokens.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { RateLimitService } from '../auth/rate-limit.service.js';

export const OWNER_KEY_HEADER = 'x-owner-key';

@Injectable()
export class OwnerKeyGuard implements CanActivate {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const expected = this.env.owner?.accessKey ?? null;
    if (!expected) throw new AppException(ERROR_CODES.NOT_FOUND, 404);
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[OWNER_KEY_HEADER];
    const given = (Array.isArray(header) ? header[0] : header) ?? '';
    if (given && timingSafeEqualStrings(given, expected)) return true;
    const limit = await this.limits.consume(`owner:ip:${request.ip ?? 'unknown'}`, 10, 900);
    if (!limit.allowed)
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    throw new AppException(ERROR_CODES.UNAUTHENTICATED, 401);
  }
}
