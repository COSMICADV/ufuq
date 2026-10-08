/**
 * The leave carry-over job — DOCUMENT 16 rule 13, AD-01 (BullMQ on Redis).
 *
 * The same shape as the attendance and goal jobs: a repeatable job under a
 * fixed key runs once per schedule across every API instance, and it wakes
 * hourly so each company turns its year at its own midnight. The work itself
 * is idempotent (`LeaveCarryOverService`), so an hourly run all year is a
 * no-op once a year's carry has been written.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { LeaveCarryOverService } from './leave-carry-over.service.js';

export const LEAVE_QUEUE = 'leave';
export const CARRY_OVER_JOB = 'leave:carry-over';
export const CARRY_OVER_PATTERN = '5 * * * *';

@Injectable()
export class LeaveScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaveScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(LeaveCarryOverService) private readonly carryOver: LeaveCarryOverService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(LEAVE_QUEUE, { connection });
    this.worker = new Worker(
      LEAVE_QUEUE,
      async () => {
        const results = await this.carryOver.runAll();
        for (const [companyId, result] of results) {
          if (result.applied > 0) {
            this.logger.log(
              `Leave carried into ${String(result.year)} for ${companyId}: ${String(result.applied)} ` +
                `balances, ${result.forfeited} days forfeited.`,
            );
          }
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Leave job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    await this.queue.upsertJobScheduler(
      CARRY_OVER_JOB,
      { pattern: CARRY_OVER_PATTERN },
      { name: CARRY_OVER_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
