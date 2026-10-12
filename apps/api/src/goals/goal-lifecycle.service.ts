/**
 * The period-end close — DOCUMENT 14 rule 7: "Period end transitions the goal
 * automatically: `achieved` if progress ≥ 100%, otherwise `missed`."
 *
 * Every write already settles the status of the goal it touches; this job
 * is for the goals nobody touches as their period runs out. It runs for each
 * company against that company's own calendar day, so a goal closes after
 * its last day has ended where the company is, not where the server is.
 *
 * **Idempotent**: it only moves goals that are `active` and whose effective
 * last day (`closingDate` — the period end, or the owner's termination date
 * when earlier) is before today. Running it twice, or late, closes each goal
 * once. The status is decided by the ledger's `settle`, the same function
 * every request uses, and audited as `goal.updated` by the company's system
 * actor (DOCUMENT 21 "Record content": a system action names the designated
 * system user, never a real administrator).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { listActiveCompanyIds, withPlatformContext } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { dateValue } from '../attendance/attendance-query.js';
import {
  SYSTEM_ACTOR_ROLE_KEY,
  SystemActorService,
  SystemActorUnavailableError,
} from '../attendance/system-actor.service.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { parseCalendarDate } from '../attendance/zoned-time.js';

import { GoalLedgerService } from './goal-ledger.service.js';

export interface PeriodEndResult {
  readonly achieved: number;
  readonly missed: number;
}

@Injectable()
export class GoalLifecycleService {
  private readonly logger = new Logger(GoalLifecycleService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(GoalLedgerService) private readonly ledger: GoalLedgerService,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {}

  /** Close one company's goals whose period has ended. */
  async closeEnded(companyId: string, now: Date = new Date()): Promise<PeriodEndResult> {
    return this.audit.withTenant(companyId, async (tx) => {
      const clock = await this.ledger.clock(tx, now);
      const today = parseCalendarDate(clock.today);
      if (today === null) {
        throw new RangeError(`Not a calendar date: ${clock.today}`);
      }
      const ended = await tx.goal.findMany({
        where: {
          status: 'active',
          deletedAt: null,
          OR: [
            { periodEnd: { lt: dateValue(today) } },
            // DOCUMENT 14: "Goal is closed at the termination date".
            { employee: { terminationDate: { lt: dateValue(today) } } },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      if (ended.length === 0) {
        return { achieved: 0, missed: 0 };
      }

      const actor = {
        companyId,
        userId: await this.systemActor.resolve(tx, companyId),
        origin: null,
      };
      let achieved = 0;
      let missed = 0;
      for (const { id } of ended) {
        const goal = await this.ledger.lock(tx, id);
        if (goal === null) continue;
        const settled = await this.ledger.settle(tx, goal, actor, clock);
        if (settled.status === 'achieved') achieved += 1;
        if (settled.status === 'missed') missed += 1;
      }
      return { achieved, missed };
    });
  }

  /** Every active company, each against its own day. */
  async runPeriodEnd(now: Date = new Date()): Promise<Map<string, PeriodEndResult>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, PeriodEndResult>();
    for (const companyId of companyIds) {
      try {
        results.set(companyId, await this.closeEnded(companyId, now));
      } catch (error) {
        if (error instanceof SystemActorUnavailableError) {
          this.logger.warn(
            `Goal period-end skipped company ${companyId}: no system actor could be resolved ` +
              `(the '${SYSTEM_ACTOR_ROLE_KEY}' system role is not seeded).`,
          );
          continue;
        }
        throw error;
      }
    }
    return results;
  }
}
