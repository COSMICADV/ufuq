/**
 * The daily reconciliation job — DOCUMENT 17 rule 3 ("a reconciliation job
 * proves this") and "Cache and ledger disagree", AD-01 (BullMQ on Redis).
 *
 * The same shape as the attendance, goal and leave jobs: one repeatable job
 * under a fixed key, so it runs once per schedule across every API instance.
 * It reconciles every active company with `rebuild: true` — a mismatch is
 * flagged, rebuilt from the ledger and alerted, never left silently — and is
 * audited by the company's designated system actor (DOCUMENT 21 "Record
 * content").
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  SYSTEM_ACTOR_ROLE_KEY,
  SystemActorService,
  SystemActorUnavailableError,
} from '../attendance/system-actor.service.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { ReconciliationService } from './reconciliation.service.js';
import type { ReconciliationReport } from './reconciliation.service.js';

export const INVENTORY_QUEUE = 'inventory';
export const RECONCILIATION_JOB = 'inventory:reconciliation';
/** Daily at 02:30 UTC — after midnight in every V1 timezone, before the working day. */
export const RECONCILIATION_PATTERN = '30 2 * * *';

@Injectable()
export class ReconciliationRunner {
  private readonly logger = new Logger(ReconciliationRunner.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
  ) {}

  /** Every active company, each with its own system actor. */
  async runAll(): Promise<Map<string, ReconciliationReport>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, ReconciliationReport>();
    for (const companyId of companyIds) {
      let actor: string;
      try {
        actor = await withTenant(this.prisma, companyId, (tx) =>
          this.systemActor.resolve(tx, companyId),
        );
      } catch (error) {
        if (error instanceof SystemActorUnavailableError) {
          this.logger.warn(
            `Reconciliation skipped company ${companyId}: no system actor ` +
              `(the '${SYSTEM_ACTOR_ROLE_KEY}' system role is not seeded).`,
          );
          continue;
        }
        throw error;
      }
      const report = await this.reconciliation.run(companyId, actor, true, null);
      if (report.mismatches.length > 0 || report.chain_breaks.length > 0) {
        this.logger.warn(
          `Reconciliation for ${companyId}: ${String(report.mismatches.length)} balance(s) rebuilt, ` +
            `${String(report.chain_breaks.length)} chain break(s).`,
        );
      }
      results.set(companyId, report);
    }
    return results;
  }
}

@Injectable()
export class ReconciliationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ReconciliationRunner) private readonly runner: ReconciliationRunner,
  ) {}

  async onModuleInit(): Promise<void> {
    // BullMQ needs its own connection with `maxRetriesPerRequest: null`.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(INVENTORY_QUEUE, { connection });
    this.worker = new Worker(
      INVENTORY_QUEUE,
      async () => {
        await this.runner.runAll();
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Reconciliation job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    await this.queue.upsertJobScheduler(
      RECONCILIATION_JOB,
      { pattern: RECONCILIATION_PATTERN },
      { name: RECONCILIATION_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
