/**
 * The goal ledger — the single place a goal's value and status change
 * (DOCUMENT 27 RULES 6 and 7).
 *
 * Three callers write through it, and none of them restates its rules:
 *
 *   - `GoalsService` — a manual update to a Sales or Custom goal, a target or
 *     period edit, creation;
 *   - `TasksService` — completing, reopening, deleting, relinking or
 *     re-prioritising a task linked to a Task goal (DOCUMENT 13 rule 8,
 *     DOCUMENT 05 FLOW 10);
 *   - `GoalLifecycleService` — the period-end close (DOCUMENT 14 rule 7).
 *
 * What it guarantees, every time:
 *
 *   - **History is appended, never rewritten** (DOCUMENT 14 rules 5 and 9).
 *     `goals.current_value` is a cache of the newest `goal_progress` row and
 *     is written only together with one, in the caller's transaction.
 *   - **A Task goal's value is derived**: the count of linked tasks that
 *     qualify under its `task_count_rule`, recomputed from the tasks rather
 *     than incremented, so a reopened task lowers it exactly as a completed
 *     one raises it (DOCUMENT 13 edge case "Reopening a completed task…").
 *   - **Status follows value and date** (`deriveStatus`) and every change of
 *     it is audited.
 *   - **Milestones are detected** on the way up and returned as events for
 *     the caller to publish after commit (`goal-events.ts`).
 *
 * The goal row is locked `FOR UPDATE` before it is read for a write, so two
 * concurrent changes each see the other's committed history.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { AuditAction, Prisma, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { dateToWire } from '../attendance/attendance-payload.js';
import {
  calendarDateIn,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { RequestOrigin } from '../common/request-context.js';
import type { TaskPriorityValue } from '../tasks/task-rules.js';

import type { GoalMilestoneEvent } from './goal-events.js';
import { GOAL_INCLUDE, goalMeasures, valueToWire } from './goal-payload.js';
import type { GoalRow } from './goal-payload.js';
import {
  deriveStatus,
  isAutomatic,
  milestonesCrossed,
  parseTaskCountRule,
  VALUE_SCALE,
} from './goal-rules.js';
import type { GoalStatusValue, GoalTypeValue } from './goal-rules.js';

/** Who is acting. The system actor for the period-end job; the caller otherwise. */
export interface GoalActor {
  readonly companyId: string;
  readonly userId: string;
  readonly origin: RequestOrigin | null;
}

/** The company's clock: its zone, and the calendar day it is there now. */
export interface CompanyClock {
  readonly timeZone: string;
  readonly today: string;
}

export interface LedgerResult {
  readonly goal: GoalRow;
  readonly events: readonly GoalMilestoneEvent[];
}

@Injectable()
export class GoalLedgerService {
  constructor(@Inject(AuditDispatcher) private readonly audit: AuditDispatcher) {}

  async clock(tx: TenantClient, now: Date = new Date()): Promise<CompanyClock> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    return {
      timeZone: company.timezone,
      today: formatCalendarDate(calendarDateIn(now, company.timezone)),
    };
  }

  /** Lock and load a live goal, or null. */
  async lock(tx: TenantClient, goalId: string): Promise<GoalRow | null> {
    await tx.$executeRaw`SELECT 1 FROM goals WHERE id = ${goalId}::uuid FOR UPDATE`;
    return tx.goal.findFirst({ where: { id: goalId, deletedAt: null }, include: GOAL_INCLUDE });
  }

  reload(tx: TenantClient, goalId: string): Promise<GoalRow> {
    return tx.goal.findUniqueOrThrow({ where: { id: goalId }, include: GOAL_INCLUDE });
  }

  /**
   * The first history row, written with the goal (DOCUMENT 05 FLOW 12: "save,
   * current value = 0 or derived"). From here on the goal always has a row for
   * its current value to be the cache of.
   */
  async open(
    tx: TenantClient,
    goal: GoalRow,
    actor: GoalActor,
    clock: CompanyClock,
  ): Promise<LedgerResult> {
    const value = isAutomatic(goal.type as GoalTypeValue)
      ? await this.derivedValue(tx, goal, clock.timeZone)
      : valueToWire(goal.currentValue);
    await tx.goalProgress.create({
      data: {
        id: generateId(),
        goalId: goal.id,
        value,
        previousValue: null,
        targetValue: goal.targetValue,
        note: null,
        source: isAutomatic(goal.type as GoalTypeValue) ? 'system' : 'manual',
        createdBy: actor.userId,
        // The application's clock, like the row's v7 id and every status
        // decision taken beside it; history is read back by this instant.
        createdAt: new Date(),
      },
    });
    if (value !== valueToWire(goal.currentValue)) {
      await tx.goal.update({ where: { id: goal.id }, data: { currentValue: value } });
    }
    const reloaded = await this.reload(tx, goal.id);
    const events = this.eventsFor(reloaded, null, actor);
    return { goal: await this.settle(tx, reloaded, actor, clock), events };
  }

  /**
   * Append a new value — DOCUMENT 14 rule 5, DOCUMENT 05 FLOW 13. The previous
   * value and the target in effect are recorded with it. Audited as
   * `goal.progress_updated`; milestones crossed are returned as events.
   */
  async append(
    tx: TenantClient,
    goal: GoalRow,
    input: {
      readonly value: string;
      readonly note: string | null;
      readonly source: 'manual' | 'system';
    },
    actor: GoalActor,
    clock: CompanyClock,
  ): Promise<LedgerResult> {
    const before = goalMeasures(goal);
    const previous = valueToWire(goal.currentValue);
    const value = Decimal.parse(input.value, VALUE_SCALE).toString();

    await tx.goalProgress.create({
      data: {
        id: generateId(),
        goalId: goal.id,
        value,
        previousValue: previous,
        targetValue: goal.targetValue,
        note: input.note,
        source: input.source,
        createdBy: actor.userId,
        // The application's clock, like the row's v7 id and every status
        // decision taken beside it; history is read back by this instant.
        createdAt: new Date(),
      },
    });
    await tx.goal.update({ where: { id: goal.id }, data: { currentValue: value } });
    const updated = await this.reload(tx, goal.id);
    const after = goalMeasures(updated);

    await this.record(tx, actor, 'GOAL_PROGRESS_UPDATED', goal.id, {
      oldValues: { current_value: previous, progress_percent: before.progressPercent },
      newValues: {
        current_value: value,
        progress_percent: after.progressPercent,
        source: input.source,
        ...(input.note === null ? {} : { note: input.note }),
      },
    });

    const events = this.eventsFor(updated, before.progressPercent, actor);
    return { goal: await this.settle(tx, updated, actor, clock), events };
  }

  /**
   * DOCUMENT 14 edge case "Target changed mid-period": allowed, audited as
   * `goal.target_changed`, and a history row is appended carrying the new
   * target beside the unchanged value — so the rows before it keep the old
   * target and the chart drawn from them "does not lie".
   */
  async retarget(
    tx: TenantClient,
    before: GoalRow,
    after: GoalRow,
    actor: GoalActor,
  ): Promise<readonly GoalMilestoneEvent[]> {
    const old = goalMeasures(before);
    const next = goalMeasures(after);
    await tx.goalProgress.create({
      data: {
        id: generateId(),
        goalId: after.id,
        value: after.currentValue,
        previousValue: before.currentValue,
        targetValue: after.targetValue,
        note: null,
        source: 'manual',
        createdBy: actor.userId,
        // The application's clock, like the row's v7 id and every status
        // decision taken beside it; history is read back by this instant.
        createdAt: new Date(),
      },
    });
    await this.record(tx, actor, 'GOAL_TARGET_CHANGED', after.id, {
      oldValues: {
        target_value: valueToWire(before.targetValue),
        progress_percent: old.progressPercent,
      },
      newValues: {
        target_value: valueToWire(after.targetValue),
        progress_percent: next.progressPercent,
      },
    });
    return this.eventsFor(after, old.progressPercent, actor);
  }

  /**
   * DOCUMENT 14 rule 4 / DOCUMENT 13 rule 8: re-derive a Task goal's value
   * from its tasks and append a `system` row when it changed. A goal that is
   * not a live, uncancelled Task goal is left alone.
   */
  async recalculate(
    tx: TenantClient,
    goalId: string,
    actor: GoalActor,
    clock: CompanyClock,
  ): Promise<readonly GoalMilestoneEvent[]> {
    const goal = await this.lock(tx, goalId);
    if (goal === null || !isAutomatic(goal.type as GoalTypeValue) || goal.status === 'cancelled') {
      return [];
    }
    const derived = await this.derivedValue(tx, goal, clock.timeZone);
    if (derived === valueToWire(goal.currentValue)) {
      await this.settle(tx, goal, actor, clock);
      return [];
    }
    const result = await this.append(
      tx,
      goal,
      { value: derived, note: null, source: 'system' },
      actor,
      clock,
    );
    return result.events;
  }

  /** Recalculate every distinct goal a task change touched (old link and new). */
  async afterTaskChange(
    tx: TenantClient,
    goalIds: readonly (string | null)[],
    actor: GoalActor,
    clock: CompanyClock,
  ): Promise<readonly GoalMilestoneEvent[]> {
    const events: GoalMilestoneEvent[] = [];
    for (const goalId of new Set(goalIds.filter((id): id is string => id !== null))) {
      events.push(...(await this.recalculate(tx, goalId, actor, clock)));
    }
    return events;
  }

  /**
   * DOCUMENT 14 rule 7 — put the status where value and date say it belongs,
   * and audit the move as `goal.updated`. No-op when it is already there.
   */
  async settle(
    tx: TenantClient,
    goal: GoalRow,
    actor: GoalActor,
    clock: CompanyClock,
  ): Promise<GoalRow> {
    const measures = goalMeasures(goal);
    const status = deriveStatus({
      status: goal.status as GoalStatusValue,
      progressPercent: measures.progressPercent,
      closesOn: measures.closesOn,
      today: clock.today,
    });
    if (status === goal.status) {
      return goal;
    }
    await tx.goal.update({ where: { id: goal.id }, data: { status } });
    await this.record(tx, actor, 'GOAL_UPDATED', goal.id, {
      oldValues: { status: goal.status },
      newValues: { status, progress_percent: measures.progressPercent },
    });
    return this.reload(tx, goal.id);
  }

  /**
   * The qualifying-task count — the approved V1 rule (DOCUMENT 14 rule 4,
   * DOCUMENT 13 rule 8 and its edge case): tasks **linked** to the goal,
   * **assigned to the goal's owner**, **completed**, whose completion falls
   * **within the goal's period** (its effective last day included) in the
   * company's timezone, and whose priority the goal's rule counts (all four
   * when none is selected). Soft-deleted tasks never count.
   */
  async derivedValue(tx: TenantClient, goal: GoalRow, timeZone: string): Promise<string> {
    const rule = parseTaskCountRule(goal.taskCountRule);
    if (rule === null) {
      throw new Error(`Goal ${goal.id} has no valid task_count_rule`);
    }
    const { closesOn } = goalMeasures(goal);
    const count = await tx.task.count({
      where: this.qualifyingWhere(goal, rule.priorities, closesOn, timeZone),
    });
    return Decimal.fromInteger(count, VALUE_SCALE).toString();
  }

  /** The same population as a `where`, for the detail screen's "counts" flag. */
  qualifyingWhere(
    goal: Pick<GoalRow, 'id' | 'employeeId' | 'periodStart'>,
    priorities: readonly TaskPriorityValue[],
    closesOn: string,
    timeZone: string,
  ): Prisma.TaskWhereInput {
    const start = parseCalendarDate(dateToWire(goal.periodStart));
    const last = parseCalendarDate(closesOn);
    if (start === null || last === null) {
      throw new RangeError('Goal period is not a calendar range');
    }
    return {
      goalId: goal.id,
      // Linking already requires the assignee to be the owner (TasksService);
      // the count states it too, so the rule never rests on that alone.
      assigneeEmployeeId: goal.employeeId,
      deletedAt: null,
      status: 'completed',
      priority: { in: [...priorities] },
      completedAt: {
        gte: instantAt(start, 0, timeZone),
        // The first instant after the last day, in the company's zone.
        lt: instantAt(last, 24 * 60, timeZone),
      },
    };
  }

  async record(
    tx: TenantClient,
    actor: GoalActor,
    action: AuditAction,
    goalId: string,
    values: { oldValues?: Prisma.InputJsonObject; newValues?: Prisma.InputJsonObject },
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId: actor.companyId,
      userId: actor.userId,
      action,
      // Every goal action is recorded against the goal, so its history panel
      // (DOCUMENT 21 "UI") is one entity query.
      entityType: 'goal',
      entityId: goalId,
      ...values,
      ipAddress: actor.origin?.ipAddress ?? null,
      userAgent: actor.origin?.userAgent ?? null,
    });
  }

  private eventsFor(
    goal: GoalRow,
    beforePercent: string | null,
    actor: GoalActor,
  ): readonly GoalMilestoneEvent[] {
    if (goal.status === 'cancelled') {
      return [];
    }
    const after = goalMeasures(goal).progressPercent;
    const occurredAt = new Date();
    return milestonesCrossed(beforePercent, after).map((milestone) => ({
      type: 'goal_milestone' as const,
      companyId: actor.companyId,
      goalId: goal.id,
      employeeId: goal.employeeId,
      createdBy: goal.createdBy,
      milestone,
      progressPercent: after,
      actorUserId: actor.userId,
      occurredAt,
    }));
  }
}
