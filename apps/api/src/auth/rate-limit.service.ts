/**
 * Redis-backed rate limiting — DOCUMENT 08 §6, AD-01.
 *
 * A blunt, fixed-window request throttle at the application layer, applied
 * in addition to (never instead of) the DOCUMENT 09 §1 account lockout:
 * this limits *request volume* to an endpoint regardless of outcome: it
 * exists so a distributed attempt against many different accounts, or many
 * attempts against one account from many IPs, cannot even reach the
 * password-verification cost before being throttled. Lockout (`AuthService`)
 * is the complementary, per-account, DB-backed control.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

@Injectable()
export class RateLimitService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async consume(key: string, max: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:${key}`;
    const count = await this.redis.incr(redisKey);
    if (count === 1) {
      await this.redis.expire(redisKey, windowSeconds);
    }
    if (count <= max) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const ttl = await this.redis.ttl(redisKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  }
}
