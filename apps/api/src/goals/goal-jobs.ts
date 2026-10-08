/**
 * The goal period-end job — DOCUMENT 14 rule 7, AD-01 (BullMQ on Redis).
 *
 * The same shape as the Phase 6 attendance job (`attendance-jobs.ts`) and
 * for the same reasons: a repeatable job under a fixed key runs once per
 * schedule across every API instance, a missed run is visible in the queue,
 * and the job wakes hourly so each company is closed against its own
 * midnight rather than the server's.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { GoalLifecycleService } from './goal-lifecycle.service.js';

export const GOALS_QUEUE = 'goals';
export const PERIOD_END_JOB = 'goals:period-end';

/** Hourly, on the hour — each company is evaluated against its own day. */
export const PERIOD_END_PATTERN = '0 * * * *';

@Injectable()
export class GoalsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GoalsScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(GoalLifecycleService) private readonly lifecycle: GoalLifecycleService,
  ) {}

  async onModuleInit(): Promise<void> {
    // BullMQ needs its own connection with `maxRetriesPerRequest: null`.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });

    this.queue = new Queue(GOALS_QUEUE, { connection });
    this.worker = new Worker(
      GOALS_QUEUE,
      async () => {
        const results = await this.lifecycle.runPeriodEnd();
        for (const [companyId, result] of results) {
          if (result.achieved > 0 || result.missed > 0) {
            this.logger.log(
              `Goals closed for ${companyId}: ${String(result.achieved)} achieved, ` +
                `${String(result.missed)} missed.`,
            );
          }
        }
      },
      { connection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Goal job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });

    await this.queue.upsertJobScheduler(
      PERIOD_END_JOB,
      { pattern: PERIOD_END_PATTERN },
      { name: PERIOD_END_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
