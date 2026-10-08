/**
 * The annual carry-over — DOCUMENT 16 rule 13 and its edge case "Carry-over
 * exceeding the cap: excess is forfeited and the forfeiture is recorded in
 * the audit log".
 *
 * For each company, against its own calendar: every balance of last year
 * whose (paid, active) type carries over is turned into this year's
 * `carried_over_days`:
 *
 *   - unused = last year's remaining (total + carried − used − pending);
 *   - `full` carries all of a positive remainder; `capped` at most the cap,
 *     forfeiting the rest; `none` carries nothing and writes nothing.
 *
 * **Idempotent and safe to rerun.** This year's row is marked
 * (`carry_over_applied_at`) when the carry is written; a marked row is never
 * touched again, so a rerun — or the hourly schedule running all year —
 * changes nothing, and never overwrites an ADMIN's later adjustment.
 *
 * **Audited** as `leave.balance_adjusted` by the company's system actor
 * (DOCUMENT 21 "Record content": system actions name a designated system
 * user): it is a change to an entitlement, recording the carried days, the
 * forfeited days and the year they came from. DOCUMENT 21 has no other leave
 * action that describes it.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';

import {
  SYSTEM_ACTOR_ROLE_KEY,
  SystemActorService,
  SystemActorUnavailableError,
} from '../attendance/system-actor.service.js';
import { AuditService } from '../auth/audit.service.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';

import { LeaveBalancesService } from './leave-balances.service.js';
import { carryOver, days, remaining } from './leave-rules.js';

export interface CarryOverResult {
  readonly year: number;
  /** Balances written this run. */
  readonly applied: number;
  /** Total days forfeited this run, across every capped balance. */
  readonly forfeited: string;
}

@Injectable()
export class LeaveCarryOverService {
  private readonly logger = new Logger(LeaveCarryOverService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(LeaveBalancesService) private readonly balances: LeaveBalancesService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
  ) {}

  /** One company: last year's balances into this year (the company's own year). */
  async runForCompany(companyId: string, now: Date = new Date()): Promise<CarryOverResult> {
    return withTenant(this.prisma, companyId, async (tx) => {
      const year = (await this.balances.today(tx, now)).year;
      const previous = await tx.leaveBalance.findMany({
        where: {
          year: year - 1,
          leaveType: { deletedAt: null, isPaid: true, carryOverPolicy: { in: ['full', 'capped'] } },
          employee: { status: { not: 'terminated' } },
        },
        include: {
          leaveType: {
            select: {
              id: true,
              defaultDaysPerYear: true,
              carryOverPolicy: true,
              carryOverCap: true,
            },
          },
          employee: { select: { id: true, joiningDate: true } },
        },
        orderBy: { id: 'asc' },
      });
      let applied = 0;
      let forfeitedTotal = days('0');
      let actor: string | null = null;

      for (const balance of previous) {
        const target = await this.balances.lock(
          tx,
          companyId,
          balance.employee,
          balance.leaveType,
          year,
        );
        const marked = await tx.leaveBalance.findUniqueOrThrow({
          where: { id: target.id },
          select: { carryOverAppliedAt: true },
        });
        if (marked.carryOverAppliedAt !== null) continue;

        const unused = remaining({
          totalDays: days(balance.totalDays),
          usedDays: days(balance.usedDays),
          pendingDays: days(balance.pendingDays),
          carriedOverDays: days(balance.carriedOverDays),
        });
        const result = carryOver(
          balance.leaveType.carryOverPolicy,
          balance.leaveType.carryOverCap === null ? null : days(balance.leaveType.carryOverCap),
          unused,
        );
        await tx.leaveBalance.update({
          where: { id: target.id },
          data: { carriedOverDays: result.carried.toString(), carryOverAppliedAt: now },
        });
        actor ??= await this.systemActor.resolve(tx, companyId);
        await this.audit.record(tx, {
          companyId,
          userId: actor,
          action: 'LEAVE_BALANCE_ADJUSTED',
          entityType: 'leave_balance',
          entityId: target.id,
          oldValues: { carried_over_days: target.carriedOverDays.toString() },
          newValues: {
            carried_over_days: result.carried.toString(),
            forfeited_days: result.forfeited.toString(),
            from_year: year - 1,
            from_balance_id: balance.id,
            reason: 'carry_over',
          },
        });
        applied += 1;
        forfeitedTotal = forfeitedTotal.add(result.forfeited);
      }
      return { year, applied, forfeited: forfeitedTotal.toString() };
    });
  }

  /** Every active company, each against its own year. */
  async runAll(now: Date = new Date()): Promise<Map<string, CarryOverResult>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));
    const results = new Map<string, CarryOverResult>();
    for (const companyId of companyIds) {
      try {
        results.set(companyId, await this.runForCompany(companyId, now));
      } catch (error) {
        if (error instanceof SystemActorUnavailableError) {
          this.logger.warn(
            `Leave carry-over skipped company ${companyId}: no system actor could be resolved ` +
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
