/**
 * Report rate limit — DOCUMENT 18 "API requirements": "Report endpoints are
 * rate limited (20/hour/user) because they are expensive"; DOCUMENT 08 §6
 * ("Reports and exports: 20 per hour per user").
 *
 * One fixed one-hour window per user, shared by every report read, export
 * and monthly-report endpoint, on its own Redis key (`report:…`) — it never
 * touches the login or invitation limits, and they never touch it. Over the
 * limit: 429 `RATE_LIMITED` with `Retry-After`.
 *
 * It runs after the global guards, so an unauthenticated or unauthorised
 * request is refused without spending the caller's allowance. Looking up a
 * queued export's status and downloading its file are not report runs and
 * are not counted (they would otherwise exhaust the allowance while polling).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { RateLimitService } from '../auth/rate-limit.service.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';

export interface ReportRateLimit {
  readonly max: number;
  readonly windowSeconds: number;
}

export const REPORT_RATE_LIMIT = Symbol('REPORT_RATE_LIMIT');
export const DEFAULT_REPORT_RATE_LIMIT: ReportRateLimit = { max: 20, windowSeconds: 3600 };

@Injectable()
export class ReportRateLimitGuard implements CanActivate {
  constructor(
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(REPORT_RATE_LIMIT) private readonly limit: ReportRateLimit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const auth = request.authContext;
    if (auth === undefined) {
      // Unreachable behind SessionAuthGuard; nothing to count against.
      return true;
    }
    const result = await this.rateLimit.consume(
      `report:${auth.companyId}:${auth.userId}`,
      this.limit.max,
      this.limit.windowSeconds,
    );
    if (!result.allowed) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
    return true;
  }
}
