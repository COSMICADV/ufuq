/**
 * Retention — DOCUMENT 19 rule 8 ("12 months, then purged"), DOCUMENT 06
 * "Deletion" (notifications: hard delete permitted after the retention
 * window) and "Retention" (notifications: 12 months).
 *
 * A daily job deletes, company by company in that company's own tenant
 * scope, the notifications created more than twelve months ago and the
 * processed-event records of the same age. Nothing younger is touched.
 * Deleting in bounded batches keeps each statement short; the job is
 * idempotent (a second run finds nothing more to delete) and retry-safe (a
 * failed company is retried the next day, and one company's failure never
 * stops the others).
 *
 * A summary that is still within the window keeps the rows it absorbed only
 * while they are within it too; an expired summary takes its absorbed rows
 * with it (`ON DELETE CASCADE`).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { RETENTION_MONTHS } from './notification-catalogue.js';

export const RETENTION_QUEUE = 'notifications-retention';
export const RETENTION_JOB = 'notifications:retention';
/** Daily, 03:20 UTC. The window is twelve months; the hour does not matter. */
export const RETENTION_PATTERN = '20 3 * * *';
const BATCH = 5_000;

/** The instant before which a notification is past retention. */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  return cutoff;
}

export interface PurgeResult {
  readonly notifications: number;
  readonly events: number;
}

@Injectable()
export class NotificationRetention {
  private readonly logger = new Logger(NotificationRetention.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async purgeAll(now: Date = new Date()): Promise<Map<string, PurgeResult>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, PurgeResult>();
    for (const companyId of companyIds) {
      try {
        results.set(companyId, await this.purgeCompany(companyId, now));
      } catch (error) {
        this.logger.error(
          `Notification retention for ${companyId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return results;
  }

  async purgeCompany(companyId: string, now: Date): Promise<PurgeResult> {
    const cutoff = retentionCutoff(now);
    let notifications = 0;
    let events = 0;
    for (;;) {
      const deleted = await withTenant(
        this.prisma,
        companyId,
        (tx) =>
          tx.$executeRaw`
          DELETE FROM "notifications"
           WHERE "id" IN (
             SELECT "id" FROM "notifications"
              WHERE "company_id" = ${companyId}::uuid AND "created_at" < ${cutoff}
              LIMIT ${BATCH}
           )`,
      );
      notifications += deleted;
      if (deleted < BATCH) break;
    }
    for (;;) {
      const deleted = await withTenant(
        this.prisma,
        companyId,
        (tx) =>
          tx.$executeRaw`
          DELETE FROM "notification_events"
           WHERE "id" IN (
             SELECT "id" FROM "notification_events"
              WHERE "company_id" = ${companyId}::uuid AND "created_at" < ${cutoff}
              LIMIT ${BATCH}
           )`,
      );
      events += deleted;
      if (deleted < BATCH) break;
    }
    return { notifications, events };
  }
}

@Injectable()
export class NotificationRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRetentionScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(NotificationRetention) private readonly retention: NotificationRetention,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(RETENTION_QUEUE, { connection });
    this.worker = new Worker(
      RETENTION_QUEUE,
      async () => {
        await this.retention.purgeAll();
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Notification retention job ${job?.id ?? 'unknown'} failed: ${error.message}`,
      );
    });
    await this.queue.upsertJobScheduler(
      RETENTION_JOB,
      { pattern: RETENTION_PATTERN },
      { name: RETENTION_JOB, opts: { removeOnComplete: 30, removeOnFail: 30 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
