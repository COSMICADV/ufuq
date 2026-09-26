/**
 * The nightly absence job — DOCUMENT 12 rule 10, AD-01 (BullMQ on Redis).
 *
 * BullMQ arrives here because this is the first background job the product
 * has: `RedisModule` has said since Phase 3 that queues would come "with the
 * first background job that needs one", and this is it.
 *
 * Why a repeatable queue job rather than a timer in the process:
 *
 *   - The API runs as more than one instance. A `setInterval` in each would
 *     run the job once per instance; a BullMQ repeatable job with a fixed id
 *     runs once per schedule across all of them.
 *   - A missed run (a deploy, a crash) is visible and retryable in the queue
 *     instead of silently not happening.
 *
 * The job itself is idempotent (see `AttendanceGenerationService`), so a retry
 * or an overlapping run cannot double-write.
 *
 * **Every company's own midnight.** The job wakes hourly rather than once a
 * day, and each run asks each company what "yesterday" is in *its* timezone.
 * A single daily UTC run would fire before midnight for companies east of UTC
 * and hours late for those west of it.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { AttendanceGenerationService } from './attendance-generation.service.js';

export const ATTENDANCE_QUEUE = 'attendance';
export const NIGHTLY_JOB = 'attendance:nightly';

/** Hourly, on the hour — see the note about every company's own midnight above. */
export const NIGHTLY_PATTERN = '0 * * * *';

@Injectable()
export class AttendanceScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AttendanceScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AttendanceGenerationService) private readonly generation: AttendanceGenerationService,
  ) {}

  async onModuleInit(): Promise<void> {
    // BullMQ needs its own connection with `maxRetriesPerRequest: null`; the
    // shared client is configured for request-scoped work (rate limiting) and
    // would abort the blocking reads a worker makes.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });

    this.queue = new Queue(ATTENDANCE_QUEUE, { connection });
    this.worker = new Worker(
      ATTENDANCE_QUEUE,
      async () => {
        const results = await this.generation.runNightly();
        for (const [companyId, result] of results) {
          if (result.generated > 0 || result.closed > 0 || result.skipped.length > 0) {
            this.logger.log(
              `Attendance generated for ${companyId}: ${String(result.generated)} created, ` +
                `${String(result.closed)} closed, ${String(result.skipped.length)} skipped.`,
            );
          }
        }
      },
      { connection },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Attendance job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });

    // A job scheduler under a fixed key: re-registering on every boot updates
    // the existing schedule rather than adding a second copy of it, so N API
    // instances still produce one run per hour between them.
    await this.queue.upsertJobScheduler(
      NIGHTLY_JOB,
      { pattern: NIGHTLY_PATTERN },
      { name: NIGHTLY_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
