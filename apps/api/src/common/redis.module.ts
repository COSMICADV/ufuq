/**
 * Redis connection — AD-01.
 *
 * Phase 3's only use of Redis is the login/forgot-password rate limiter
 * (DOCUMENT 08 §6). BullMQ queues arrive with the first background job that
 * needs one; nothing in Phase 3 does.
 */

import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import { Redis } from 'ioredis';

import { REDIS_CLIENT } from './redis.tokens.js';

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycle.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
    this.logger.log('Redis connection closed.');
  }
}

@Module({})
export class RedisModule {
  static register(env: Env): DynamicModule {
    return {
      module: RedisModule,
      global: true,
      providers: [
        {
          provide: REDIS_CLIENT,
          useFactory: () => new Redis(env.redisUrl, { maxRetriesPerRequest: 2 }),
        },
        RedisLifecycle,
      ],
      exports: [REDIS_CLIENT],
    };
  }
}
