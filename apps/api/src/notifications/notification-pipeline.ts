/**
 * The notification pipeline — DOCUMENT 19 "Architecture":
 *
 *   domain event → notification rule → recipient resolution → channel
 *   dispatch → storage
 *
 * It is entered only from a module's event publisher, which runs **after**
 * that module's transaction has committed (DOCUMENT 19 rule 2). A rolled-back
 * change never publishes, so it never notifies.
 *
 * One batch (the events one operation published) is processed per company
 * in **one tenant transaction**:
 *
 *   1. Each event's key is claimed in `notification_events`. A key already
 *      there was processed before — a retry, or an hourly scan seeing the
 *      same overdue task again — and is skipped (idempotence, DOCUMENT 19
 *      rule 3).
 *   2. Its rule resolves recipients through their permissions.
 *   3. The actor is removed from their own action's recipients.
 *   4. The company's per-event channel preferences are applied (rule 10).
 *   5. A decision marks the other approvers' notifications handled.
 *   6. Each channel dispatches; `in_app` stores, grouping as rule 4 says.
 *
 * Any failure rolls the whole batch back — claims included — so a retry
 * starts clean and creates nothing twice. **A failure never reaches the
 * module that published**: its change has already committed (`submit` never
 * throws). The batch goes to a durable retry queue (BullMQ on the existing
 * Redis, the audit dispatcher's pattern) with exponential backoff; if even
 * the enqueue fails, or the retries run out, the batch is logged in full at
 * error level under `NOTIFICATION_FALLBACK`, so nothing is lost silently
 * (DOCUMENT 19 rule 9).
 */

import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateId, withTenant } from '@ufuq/db';
import type { NotificationType, PrismaClient, TenantClient } from '@ufuq/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { NOTIFICATION_CHANNELS } from './notification-channels.js';
import type { Dispatchable, NotificationChannelDispatcher } from './notification-channels.js';
import { NotificationRules } from './notification-rules.js';
import type { Resolution } from './notification-rules.js';
import { eventKey, fromQueued, toQueued } from './notification-sources.js';
import type { QueuedSourceEvent, SourceEvent } from './notification-sources.js';

export const NOTIFICATIONS_QUEUE = 'notifications';
export const NOTIFICATION_RETRY_JOB = 'notifications:deliver';
const RETRY_ATTEMPTS = 8;
const RETRY_BACKOFF_MS = 5_000;

export interface QueuedBatch {
  readonly companyId: string;
  readonly events: readonly QueuedSourceEvent[];
}

/** Where a batch that failed goes to be retried. */
export interface NotificationRetryQueue {
  enqueue(batch: QueuedBatch): Promise<void>;
}

export const NOTIFICATION_RETRY_QUEUE = Symbol('NOTIFICATION_RETRY_QUEUE');

export interface ProcessResult {
  /** Events processed now (not seen before). */
  readonly processed: number;
  /** Notifications handed to the channels. */
  readonly dispatched: number;
}

function batchId(batch: QueuedBatch): string {
  const keys = batch.events.map((event) => eventKey(fromQueued(event))).join('\n');
  return createHash('sha256').update(`${batch.companyId}\n${keys}`).digest('hex');
}

function logFallback(logger: Logger, batch: QueuedBatch, error: unknown): void {
  logger.error(
    `NOTIFICATION_FALLBACK ${JSON.stringify(batch)} — ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** BullMQ producer, opened on first use (a process that never fails never opens it). */
@Injectable()
export class BullMqNotificationRetryQueue implements NotificationRetryQueue, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(batch: QueuedBatch): Promise<void> {
    this.queue ??= new Queue(NOTIFICATIONS_QUEUE, {
      connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
    });
    await this.queue.add(NOTIFICATION_RETRY_JOB, batch, {
      // The same batch enqueued twice is one job.
      jobId: batchId(batch),
      attempts: RETRY_ATTEMPTS,
      backoff: { type: 'exponential', delay: RETRY_BACKOFF_MS },
      removeOnComplete: 1000,
      removeOnFail: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
  }
}

@Injectable()
export class NotificationPipeline {
  private readonly logger = new Logger(NotificationPipeline.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(NotificationRules) private readonly rules: NotificationRules,
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: readonly NotificationChannelDispatcher[],
    @Inject(NOTIFICATION_RETRY_QUEUE) private readonly retry: NotificationRetryQueue,
  ) {}

  /**
   * Hand committed events to the pipeline. Never throws: a failure is queued
   * for retry, or logged in full if it cannot even be queued.
   */
  async submit(events: readonly SourceEvent[]): Promise<void> {
    const byCompany = new Map<string, SourceEvent[]>();
    for (const event of events) {
      const list = byCompany.get(event.companyId) ?? [];
      list.push(event);
      byCompany.set(event.companyId, list);
    }
    for (const [companyId, batch] of byCompany) {
      try {
        await this.process(companyId, batch);
      } catch (error) {
        const queued: QueuedBatch = { companyId, events: batch.map(toQueued) };
        this.logger.warn(
          `Notifications for ${String(batch.length)} event(s) of company ${companyId} not delivered; ` +
            `queued for retry: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          await this.retry.enqueue(queued);
        } catch (enqueueError) {
          logFallback(this.logger, queued, enqueueError);
        }
      }
    }
  }

  /** The retry worker's entry point: the same processing, idempotent on the event keys. */
  async processQueued(batch: QueuedBatch, now: Date = new Date()): Promise<ProcessResult> {
    return this.process(batch.companyId, batch.events.map(fromQueued), now);
  }

  async process(
    companyId: string,
    events: readonly SourceEvent[],
    now: Date = new Date(),
  ): Promise<ProcessResult> {
    return withTenant(this.prisma, companyId, async (tx) => {
      const disabled = await this.disabledByChannel(tx);
      const items: Dispatchable[] = [];
      const resolutions: Resolution[] = [];
      let processed = 0;

      for (const event of events) {
        const eventId = await this.claim(tx, companyId, event);
        if (eventId === null) continue;
        processed += 1;
        const outcome = await this.rules.apply(tx, event);
        if (outcome.resolves !== null) resolutions.push(outcome.resolves);
        for (const draft of outcome.drafts) {
          // DOCUMENT 19 "Employee is their own approver": no notification
          // telling someone about their own action.
          if (draft.userId === outcome.actorUserId) continue;
          items.push({ ...draft, eventId });
        }
      }

      for (const resolution of resolutions) {
        await this.resolve(tx, companyId, resolution, now);
      }

      let dispatched = 0;
      for (const channel of this.channels) {
        const off = disabled.get(channel.channel) ?? new Set<NotificationType>();
        const forChannel = items.filter((item) => !off.has(item.type));
        if (forChannel.length === 0) continue;
        await channel.dispatch(tx, companyId, forChannel, now);
        dispatched += forChannel.length;
      }
      return { processed, dispatched };
    });
  }

  /** Claims the event's key; null when it was already processed. */
  private async claim(
    tx: TenantClient,
    companyId: string,
    event: SourceEvent,
  ): Promise<string | null> {
    const id = generateId();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "notification_events" ("id", "company_id", "event_key", "event_type")
      VALUES (${id}::uuid, ${companyId}::uuid, ${eventKey(event)}, ${event.type})
      ON CONFLICT ("company_id", "event_key") DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  }

  /**
   * "Multiple approvers: the first decision resolves it and the notification
   * is marked handled for the others" — and read, since nothing is left for
   * them to do.
   */
  private async resolve(
    tx: TenantClient,
    companyId: string,
    resolution: Resolution,
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "notifications"
         SET "handled_at" = ${now}, "read_at" = COALESCE("read_at", ${now}), "updated_at" = ${now}
       WHERE "company_id" = ${companyId}::uuid
         AND "related_type" = ${resolution.relatedType}
         AND "related_id" = ${resolution.relatedId}::uuid
         AND "type"::text = ANY(${[...resolution.types]}::text[])
         AND "handled_at" IS NULL`;
  }

  /** DOCUMENT 19 rule 10: the types this company has switched off, per channel. */
  private async disabledByChannel(tx: TenantClient): Promise<Map<string, Set<NotificationType>>> {
    const rows = await tx.companyNotificationSetting.findMany({
      where: { enabled: false },
      select: { type: true, channel: true },
    });
    const map = new Map<string, Set<NotificationType>>();
    for (const row of rows) {
      const set = map.get(row.channel) ?? new Set<NotificationType>();
      set.add(row.type);
      map.set(row.channel, set);
    }
    return map;
  }
}

/** The retry worker. Registered only in a process that runs background jobs. */
@Injectable()
export class NotificationRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationRetryWorker.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(NotificationPipeline) private readonly pipeline: NotificationPipeline,
  ) {}

  onModuleInit(): void {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<QueuedBatch>(
      NOTIFICATIONS_QUEUE,
      async (job) => {
        await this.pipeline.processQueued(job.data);
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      if (job === undefined) return;
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        // Out of retries: still never silent. The failed job stays in the queue too.
        logFallback(this.logger, job.data, error);
      } else {
        this.logger.warn(`Notification retry ${String(job.attemptsMade)} failed: ${error.message}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
