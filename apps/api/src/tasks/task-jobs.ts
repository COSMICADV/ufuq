/**
 * The task deadline scan — DOCUMENT 19 `task_deadline_approaching` ("24 hours
 * before deadline") and `task_overdue` ("task passes its deadline"), AD-01.
 *
 * Overdue is derived, never stored (DOCUMENT 13 rule 1), so there is no write
 * to hang the moment on. A repeatable job therefore runs hourly and, for each
 * active company, reads the tasks the module's own predicates select, in that
 * company's calendar:
 *
 *   - **Overdue** is `overdueWhere(today)` — DOCUMENT 13 rule 1 exactly, the
 *     same condition the task list and the performance engine use. Only tasks
 *     whose deadline passed in the last {@link OVERDUE_LOOKBACK_DAYS} days are
 *     considered, so a task overdue for longer is not re-announced after the
 *     processed-event ledger's retention.
 *   - **Approaching**: a deadline is a calendar day, and a task becomes overdue
 *     when that day ends in the company's zone. The 24 hours before that are
 *     the deadline day itself, so an open task due *today* is approaching.
 *
 * The scan publishes every match each run. Saying it **once** is the
 * notification pipeline's job: the event key carries the task and its
 * deadline, so the same moment is one notification however often the scan
 * sees it, and a moved deadline is a new moment (DOCUMENT 19 rule 3: overdue
 * "once per task, not daily"). Running hourly makes it retry-safe; each
 * company is read in its own tenant scope and published as one batch, so a
 * run that finds many tasks for one manager is one summary (DOCUMENT 19
 * "Bulk operation").
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { calendarDateIn, formatCalendarDate } from '../attendance/zoned-time.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { REDIS_CLIENT } from '../common/redis.tokens.js';

import { TaskEventPublisher } from './task-events.js';
import type { TaskEvent } from './task-events.js';
import { dateValue, overdueWhere } from './task-query.js';
import { OPEN_STATUSES } from './task-rules.js';

export const TASKS_QUEUE = 'tasks';
export const DEADLINE_SCAN_JOB = 'tasks:deadline-scan';
/** Hourly, ten past: every company's day boundary is seen within the hour. */
export const DEADLINE_SCAN_PATTERN = '10 * * * *';
export const OVERDUE_LOOKBACK_DAYS = 30;

function shiftDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class TaskDeadlineScanner {
  private readonly logger = new Logger(TaskDeadlineScanner.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(TaskEventPublisher) private readonly events: TaskEventPublisher,
  ) {}

  /** Every active company; returns the events published per company. */
  async runAll(now: Date = new Date()): Promise<Map<string, number>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, number>();
    for (const companyId of companyIds) {
      try {
        results.set(companyId, await this.runCompany(companyId, now));
      } catch (error) {
        // One company's failure never stops the others; the next hour retries it.
        this.logger.error(
          `Task deadline scan for ${companyId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return results;
  }

  async runCompany(companyId: string, now: Date): Promise<number> {
    const events = await withTenant(this.prisma, companyId, async (tx) => {
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      const today = formatCalendarDate(calendarDateIn(now, company.timezone));
      const select = { id: true, assigneeEmployeeId: true, deadline: true } as const;
      const overdue = await tx.task.findMany({
        where: {
          AND: [
            overdueWhere(today),
            {
              deletedAt: null,
              deadline: { gte: dateValue(shiftDays(today, -OVERDUE_LOOKBACK_DAYS)) },
            },
          ],
        },
        select,
      });
      const approaching = await tx.task.findMany({
        where: { deletedAt: null, deadline: dateValue(today), status: { in: [...OPEN_STATUSES] } },
        select,
      });
      const toEvent =
        (type: 'task_overdue' | 'task_deadline_approaching') =>
        (row: (typeof overdue)[number]): TaskEvent => ({
          type,
          companyId,
          taskId: row.id,
          assigneeEmployeeId: row.assigneeEmployeeId,
          deadline: (row.deadline as Date).toISOString().slice(0, 10),
          occurredAt: now,
        });
      return [
        ...overdue.map(toEvent('task_overdue')),
        ...approaching.map(toEvent('task_deadline_approaching')),
      ];
    });
    await this.events.publish(events);
    return events.length;
  }
}

@Injectable()
export class TaskJobsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskJobsScheduler.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(TaskDeadlineScanner) private readonly scanner: TaskDeadlineScanner,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = this.redis.duplicate({ maxRetriesPerRequest: null });
    this.queue = new Queue(TASKS_QUEUE, { connection });
    this.worker = new Worker(
      TASKS_QUEUE,
      async () => {
        await this.scanner.runAll();
      },
      { connection },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(`Task job ${job?.id ?? 'unknown'} failed: ${error.message}`);
    });
    await this.queue.upsertJobScheduler(
      DEADLINE_SCAN_JOB,
      { pattern: DEADLINE_SCAN_PATTERN },
      { name: DEADLINE_SCAN_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
