/**
 * Report background work — DOCUMENT 18 rule 1 ("generated on the 1st of each
 * month"), DOCUMENT 05 FLOW 19, DOCUMENT 18 "Performance" (long exports run
 * as background jobs), AD-01 (BullMQ on the existing Redis).
 *
 * **Monthly snapshots.** A repeatable job runs every hour. For each active
 * company it reads the company's own calendar day; on the 1st (in *that*
 * company's timezone) it generates every applicable employee's missing
 * snapshot for the month that has just closed. Running hourly through the
 * 1st makes it retry-safe — a failed run is retried an hour later — and
 * generation only fills what is missing, so a second run, or two instances,
 * create nothing twice (the unique `(employee, year, month)` holds besides).
 * The current, unfinished month is never generated. Each company is handled
 * in its own tenant transaction as its designated system actor (DOCUMENT 21
 * rule 8: the monthly report job leaves audit records).
 *
 * **Exports.** A queued export is a job on the same queue (`reports:export`),
 * retried with backoff; the runner itself is retry-safe.
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
import { calendarDateIn } from '../attendance/zoned-time.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';
import { monthOf } from '../performance/performance-month.js';
import type { Month } from '../performance/performance-month.js';

import { MonthlyReportsService } from './monthly-reports.service.js';
import { ReportExportRunner } from './report-exports.js';
import type { ReportExportQueue } from './report-exports.js';

export const REPORTS_QUEUE = 'reports';
export const MONTHLY_REPORTS_JOB = 'reports:monthly';
export const EXPORT_JOB = 'reports:export';
/** Hourly, five past: every company's 1st is covered whatever its timezone. */
export const MONTHLY_REPORTS_PATTERN = '5 * * * *';

/** The month before the one `today` is in. */
export function previousMonth(today: { readonly year: number; readonly month: number }): Month {
  return today.month === 1 ? monthOf(today.year - 1, 12) : monthOf(today.year, today.month - 1);
}

@Injectable()
export class MonthlyReportRunner {
  private readonly logger = new Logger(MonthlyReportRunner.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(MonthlyReportsService) private readonly reports: MonthlyReportsService,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
  ) {}

  /**
   * Every active company whose calendar day is the 1st generates last month.
   * `force` skips the day check (an operator re-run); it still only fills
   * what is missing. Returns the snapshots created per company.
   */
  async runAll(now: Date = new Date(), force = false): Promise<Map<string, number>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, number>();
    for (const companyId of companyIds) {
      try {
        const created = await this.runCompany(companyId, now, force);
        if (created !== null) results.set(companyId, created);
      } catch (error) {
        // One company's failure never stops the others; the hourly schedule retries it.
        this.logger.error(
          `Monthly reports for ${companyId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return results;
  }

  /** One company; null when it is not the 1st there (and not forced) or it has no actor. */
  async runCompany(companyId: string, now: Date, force = false): Promise<number | null> {
    const setup = await withTenant(this.prisma, companyId, async (tx) => {
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      const today = calendarDateIn(now, company.timezone);
      if (!force && today.day !== 1) return null;
      try {
        return { today, actor: await this.systemActor.resolve(tx, companyId) };
      } catch (error) {
        if (error instanceof SystemActorUnavailableError) {
          this.logger.warn(
            `Monthly reports skipped company ${companyId}: no system actor ` +
              `(the '${SYSTEM_ACTOR_ROLE_KEY}' system role is not seeded).`,
          );
          return null;
        }
        throw error;
      }
    });
    if (setup === null) return null;
    return this.reports.generateMissing(companyId, setup.actor, previousMonth(setup.today), now);
  }
}

/** The `reports` queue: the hourly monthly job and queued exports. */
@Injectable()
export class ReportJobsScheduler implements ReportExportQueue, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReportJobsScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(MonthlyReportRunner) private readonly monthly: MonthlyReportRunner,
    @Inject(ReportExportRunner) private readonly exports: ReportExportRunner,
  ) {}

  async onModuleInit(): Promise<void> {
    // BullMQ needs its own connection with `maxRetriesPerRequest: null`.
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(REPORTS_QUEUE, { connection });
    this.worker = new Worker(
      REPORTS_QUEUE,
      async (job) => {
        if (job.name === EXPORT_JOB) {
          const data = job.data as { exportId: string; companyId: string };
          await this.exports.run(data.exportId, data.companyId);
        } else {
          await this.monthly.runAll();
        }
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Report job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    await this.queue.upsertJobScheduler(
      MONTHLY_REPORTS_JOB,
      { pattern: MONTHLY_REPORTS_PATTERN },
      { name: MONTHLY_REPORTS_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async enqueue(job: { readonly exportId: string; readonly companyId: string }): Promise<void> {
    if (this.queue === null) {
      throw new Error('The reports queue is not started');
    }
    await this.queue.add(EXPORT_JOB, job, {
      jobId: `export-${job.exportId}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
