/**
 * Post-commit audit dispatch — DOCUMENT 21 "Business rules" §1–§3 and the
 * "Audit write fails" edge case.
 *
 * The business transaction commits first; its audit records are written
 * afterwards, each in its own short tenant transaction. Therefore:
 *
 *   - **A rolled-back transaction produces no audit record.** The caller
 *     collects entries while its transaction runs and dispatches them only
 *     once it has returned. A throw never reaches the dispatch.
 *   - **An audit failure never undoes the committed action.** `dispatch`
 *     never throws.
 *   - **A failed write is never silent or dropped** (§2). It goes to the
 *     durable retry queue (BullMQ on the existing Redis, AD-01), which retries
 *     with backoff. If even the enqueue fails, the full entry is logged at
 *     error level under `AUDIT_FALLBACK`, so it can be recovered from the logs.
 *
 * The write itself is still `AuditService.record`, the single audit writer.
 * This class only decides *when* that write happens. The id and time are fixed
 * at dispatch, so a retry cannot duplicate a record (a unique violation on
 * the pre-assigned id means an earlier attempt landed). The record also keeps
 * the moment the action committed.
 *
 * Two ways in, one mechanism:
 *
 *   - **`withTenant` + `record`**: every module's write transaction is
 *     opened here (directly, or through `TenantScopedService.tenant`), and
 *     `record(tx, …)` buffers the entry against that transaction. Phases 3–9
 *     use this.
 *   - **`dispatch(entries)`**: a caller collects its own entries and hands
 *     them over after commit. Phase 10 Leave uses this.
 *
 * `AuditService.record` is the raw writer. Only this class calls it, apart
 * from `AuthService`'s audit-only writes, which have no business change to
 * commit first.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { generateId, withTenant } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { AuditService } from './audit.service.js';
import type { AuditEntry } from './audit.service.js';

export const AUDIT_QUEUE = 'audit';
export const AUDIT_RETRY_JOB = 'audit:write';
const RETRY_ATTEMPTS = 10;
const RETRY_BACKOFF_MS = 5_000;

/** An entry as it travels through the queue: JSON, so the time is a string. */
export type QueuedAuditEntry = Omit<AuditEntry, 'occurredAt'> & {
  readonly id: string;
  readonly occurredAt: string;
};

/** Where a post-commit write that failed goes to be retried. */
export interface AuditRetryQueue {
  enqueue(entry: QueuedAuditEntry): Promise<void>;
}

export const AUDIT_RETRY_QUEUE = Symbol('AUDIT_RETRY_QUEUE');

function logFallback(logger: Logger, entry: QueuedAuditEntry, error: unknown): void {
  logger.error(
    `AUDIT_FALLBACK ${JSON.stringify(entry)} — ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Prisma's unique violation (`P2002`): the pre-assigned id already landed. */
function isDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function fromQueue(entry: QueuedAuditEntry): AuditEntry {
  return { ...entry, occurredAt: new Date(entry.occurredAt) };
}

/** BullMQ producer. The queue is opened on first use, so a process that never fails a write never opens it. */
@Injectable()
export class BullMqAuditRetryQueue implements AuditRetryQueue, OnModuleDestroy {
  private queue: Queue | null = null;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async enqueue(entry: QueuedAuditEntry): Promise<void> {
    this.queue ??= new Queue(AUDIT_QUEUE, {
      connection: this.redis.duplicate({ maxRetriesPerRequest: null }),
    });
    await this.queue.add(AUDIT_RETRY_JOB, entry, {
      // The record id is the job id: enqueueing the same entry twice is one job.
      jobId: entry.id,
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
export class AuditDispatcher {
  private readonly logger = new Logger(AuditDispatcher.name);
  /** The entries each open transaction has recorded, keyed by its client. */
  private readonly scopes = new WeakMap<TenantClient, AuditEntry[]>();

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AUDIT_RETRY_QUEUE) private readonly retry: AuditRetryQueue,
  ) {}

  /**
   * `withTenant`, with every `record` made inside it written after it commits.
   * If `fn` throws, the transaction rolls back and its entries are discarded
   * unwritten. If it commits, they are dispatched before this returns, so a
   * caller that publishes events after it still publishes them after the audit.
   */
  async withTenant<T>(companyId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    const entries: AuditEntry[] = [];
    const result = await withTenant(this.prisma, companyId, (tx) => {
      this.scopes.set(tx, entries);
      return fn(tx);
    });
    await this.dispatch(entries);
    return result;
  }

  /**
   * Record an audit entry for the transaction `tx` belongs to. Nothing is
   * written yet: the entry is written after that transaction commits. Its id
   * and time are fixed now, so the records of one action keep their order.
   *
   * Refuses a `tx` this dispatcher did not open (`withTenant` above). A path
   * that would silently audit inside its own transaction fails loudly instead.
   */
  record(tx: TenantClient, entry: AuditEntry): Promise<void> {
    const scope = this.scopes.get(tx);
    if (scope === undefined) {
      return Promise.reject(
        new Error(
          `Audit ${entry.action} recorded outside a post-commit scope: open the transaction with AuditDispatcher.withTenant.`,
        ),
      );
    }
    scope.push({
      ...entry,
      id: entry.id ?? generateId(),
      occurredAt: entry.occurredAt ?? new Date(),
    });
    return Promise.resolve();
  }

  /** Call only after the business transaction has committed. Never throws. */
  async dispatch(entries: readonly AuditEntry[], occurredAt: Date = new Date()): Promise<void> {
    for (const entry of entries) {
      const fixed: QueuedAuditEntry = {
        ...entry,
        id: entry.id ?? generateId(),
        occurredAt: (entry.occurredAt ?? occurredAt).toISOString(),
      };
      try {
        await this.write(fixed);
      } catch (error) {
        this.logger.warn(
          `Audit ${fixed.action} for ${fixed.entityType} ${fixed.entityId} not written after commit; ` +
            `queued for retry: ${error instanceof Error ? error.message : String(error)}`,
        );
        try {
          await this.retry.enqueue(fixed);
        } catch (enqueueError) {
          logFallback(this.logger, fixed, enqueueError);
        }
      }
    }
  }

  /** One write, in its own tenant transaction. Idempotent on the pre-assigned id. */
  async write(entry: QueuedAuditEntry): Promise<void> {
    try {
      await withTenant(this.prisma, entry.companyId, (tx) =>
        this.audit.record(tx, fromQueue(entry)),
      );
    } catch (error) {
      if (isDuplicate(error)) return;
      throw error;
    }
  }
}

/** The retry worker. Registered only in a process that runs background jobs. */
@Injectable()
export class AuditRetryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditRetryWorker.name);
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(AuditDispatcher) private readonly dispatcher: AuditDispatcher,
  ) {}

  onModuleInit(): void {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.worker = new Worker<QueuedAuditEntry>(
      AUDIT_QUEUE,
      async (job) => {
        await this.dispatcher.write(job.data);
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      if (job === undefined) return;
      if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
        // Out of retries: still never silent (DOCUMENT 21 §2). The failed job stays in the queue too.
        logFallback(this.logger, job.data, error);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
