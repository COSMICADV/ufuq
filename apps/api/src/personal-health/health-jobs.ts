/**
 * The health trash purge — daily, as the notification retention job is: a
 * repeatable BullMQ job under a fixed key, so it runs once per schedule
 * across every API instance. Documents trashed more than 30 days ago are
 * removed with their files.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { PersonalHealthService } from './health.service.js';

export const HEALTH_QUEUE = 'personal-health';
export const TRASH_JOB = 'personal-health:trash-purge';
/** 03:40 UTC daily, clear of the other nightly jobs. */
export const TRASH_PATTERN = '40 3 * * *';

@Injectable()
export class PersonalHealthScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PersonalHealthScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PersonalHealthService) private readonly health: PersonalHealthService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(HEALTH_QUEUE, { connection });
    this.worker = new Worker(
      HEALTH_QUEUE,
      async () => {
        const removed = await this.health.purgeExpired();
        if (removed > 0) this.logger.log(`Health trash purge removed ${String(removed)} document(s)`);
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Health trash purge job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    await this.queue.upsertJobScheduler(
      TRASH_JOB,
      { pattern: TRASH_PATTERN },
      { name: TRASH_JOB, opts: { removeOnComplete: 30, removeOnFail: 30 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
