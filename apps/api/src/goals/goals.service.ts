/**
 * Goals — DOCUMENT 14, DOCUMENT 08 §4.8, DOCUMENT 05 FLOWS 12–13.
 *
 * The rules that carry the weight, each written once elsewhere and applied
 * here:
 *
 *   - **Value and status change only through the ledger**
 *     (`goal-ledger.service.ts`): history is appended, never rewritten; a Task
 *     goal's value is derived; the status follows value and period.
 *   - **Sales and Custom goals take manual updates from Admin or Manager; a
 *     Task goal takes none** (DOCUMENT 14 rules 3–4). Employees never edit
 *     their own figures — they hold no `goal.update_progress` (DOCUMENT 02).
 *   - **A cancelled goal takes no further change** (DOCUMENT 14 "Error
 *     states": 422).
 *   - **Scope** (DOCUMENT 09 §4): another company's goal is a 404 — row-level
 *     security has already hidden it; a goal in the tenant but outside the
 *     caller's `goal.view` scope is a 403, as is a visible goal the action's
 *     own scope does not reach.
 *   - **Audit** (DOCUMENT 21): `goal.created`, `goal.updated`,
 *     `goal.progress_updated`, `goal.target_changed`, `goal.cancelled`, each
 *     in the same transaction as the change.
 *   - **Milestones** are detected by the ledger and published only after the
 *     transaction commits (`goal-events.ts`).
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { dateToWire } from '../attendance/attendance-payload.js';
import { diffSnapshots } from '../employees/employee-payload.js';
import { employeeScopeWhere } from '../employees/employee-query.js';
import { dateValue, taskScopeWhere } from '../tasks/task-query.js';
import type { TaskPriorityValue, TaskStatusValue } from '../tasks/task-rules.js';

import type {
  CreateGoalDto,
  CreateGoalProgressDto,
  GoalProgressQueryDto,
  ListGoalsQueryDto,
  UpdateGoalDto,
} from './dto/goal.dto.js';
import { GoalEventPublisher } from './goal-events.js';
import type { GoalMilestoneEvent } from './goal-events.js';
import { GoalLedgerService } from './goal-ledger.service.js';
import type { CompanyClock, GoalActor } from './goal-ledger.service.js';
import {
  GOAL_INCLUDE,
  GOAL_PROGRESS_INCLUDE,
  goalAuditSnapshot,
  goalDetailPayload,
  goalMeasures,
  goalPayload,
  goalProgressPayload,
} from './goal-payload.js';
import type {
  GoalDetailPayload,
  GoalPayload,
  GoalProgressPayload,
  GoalRow,
} from './goal-payload.js';
import { forbidden, goalScopeWhere, hasGoalScope, LIST_ORDER, listWhere } from './goal-query.js';
import {
  DEFAULT_TASK_COUNT_RULE,
  isAutomatic,
  isValidPeriod,
  parseTaskCountRule,
  TASK_GOAL_UNIT,
  VALUE_SCALE,
} from './goal-rules.js';
import type { GoalTypeValue, Milestone, TaskCountRule } from './goal-rules.js';

export interface GoalList {
  readonly items: readonly GoalPayload[];
  readonly total: number;
}

export interface GoalProgressList {
  readonly items: readonly GoalProgressPayload[];
  readonly total: number;
}

/**
 * The create and edit responses add DOCUMENT 14 rule 8's warning: an
 * overlapping goal of the same type for the same employee "is allowed but
 * warned".
 */
export type GoalWriteWarning = 'overlapping_goal';

export interface GoalWritePayload extends GoalDetailPayload {
  readonly warnings: readonly GoalWriteWarning[];
}

export interface GoalProgressWritePayload extends GoalDetailPayload {
  /** The milestones this update crossed (DOCUMENT 14 rule 6). */
  readonly milestones_crossed: readonly Milestone[];
}

/** DOCUMENT 21 general-edit fields; the target has its own action. */
const GENERAL_FIELDS = [
  'title',
  'description',
  'unit',
  'period_start',
  'period_end',
  'task_count_rule',
] as const;

type GoalPermission = 'goal.update' | 'goal.update_progress';

@Injectable()
export class GoalsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(GoalLedgerService) private readonly ledger: GoalLedgerService,
    @Inject(GoalEventPublisher) private readonly events: GoalEventPublisher,
    @Inject(AuditDispatcher) audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  // -- Reads -----------------------------------------------------------------

  async list(ctx: AuthContext, query: ListGoalsQueryDto, now = new Date()): Promise<GoalList> {
    const scope = goalScopeWhere(ctx, 'goal.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const clock = await this.ledger.clock(tx, now);
      const where = listWhere(scope, query);
      const [rows, total] = await Promise.all([
        tx.goal.findMany({
          where,
          include: GOAL_INCLUDE,
          orderBy: LIST_ORDER,
          skip: page.skip,
          take: page.take,
        }),
        tx.goal.count({ where }),
      ]);
      return { items: rows.map((row) => goalPayload(row, clock.today)), total };
    });
  }

  async findOne(ctx: AuthContext, id: string, now = new Date()): Promise<GoalDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await this.loadVisible(tx, ctx, id);
      return this.detail(tx, ctx, row, await this.ledger.clock(tx, now));
    });
  }

  async listProgress(
    ctx: AuthContext,
    id: string,
    query: GoalProgressQueryDto,
  ): Promise<GoalProgressList> {
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      await this.loadVisible(tx, ctx, id);
      const [rows, total] = await Promise.all([
        tx.goalProgress.findMany({
          where: { goalId: id },
          include: GOAL_PROGRESS_INCLUDE,
          // Newest first, like every history in the product; the chart reverses it.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.goalProgress.count({ where: { goalId: id } }),
      ]);
      return { items: rows.map(goalProgressPayload), total };
    });
  }

  // -- Create / edit / cancel ------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateGoalDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<GoalWritePayload> {
    if (!isValidPeriod(dto.period_start, dto.period_end)) {
      throw fieldError({ period_end: ['end_before_start'] });
    }
    const rule = ruleFor(dto.type, dto.task_count_rule);
    assertTargetFits(dto.type, dto.target_value);

    const events: GoalMilestoneEvent[] = [];
    const result = await this.tenant(ctx, async (tx) => {
      const clock = await this.ledger.clock(tx, now);
      const owner = await this.requireOwner(tx, ctx, dto.employee_id);
      const unit = await this.unitFor(tx, dto.type, dto.unit);

      const id = generateId();
      await tx.goal.create({
        data: {
          id,
          companyId: ctx.companyId,
          employeeId: owner,
          type: dto.type,
          title: dto.title,
          description: emptyToNull(dto.description),
          targetValue: Decimal.parse(dto.target_value, VALUE_SCALE).toString(),
          currentValue: '0',
          unit,
          periodStart: dateValue(dto.period_start),
          periodEnd: dateValue(dto.period_end),
          status: 'active',
          ...(rule === null ? {} : { taskCountRule: rule as unknown as Prisma.InputJsonObject }),
          createdBy: ctx.userId,
          createdAt: now,
        },
      });
      const actor = this.actor(ctx, origin);
      const created = await this.ledger.reload(tx, id);
      await this.ledger.record(tx, actor, 'GOAL_CREATED', id, {
        newValues: goalAuditSnapshot(created),
      });
      const opened = await this.ledger.open(tx, created, actor, clock);
      events.push(...opened.events);

      return {
        ...(await this.detail(tx, ctx, opened.goal, clock)),
        warnings: await this.warningsFor(tx, opened.goal),
      };
    });
    await this.events.publish(events);
    return result;
  }

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateGoalDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<GoalWritePayload> {
    const events: GoalMilestoneEvent[] = [];
    const result = await this.tenant(ctx, async (tx) => {
      const clock = await this.ledger.clock(tx, now);
      const before = await this.loadForWrite(tx, ctx, id, 'goal.update');
      assertNotCancelled(before);
      const type = before.type as GoalTypeValue;

      const periodStart = dto.period_start ?? dateToWire(before.periodStart);
      const periodEnd = dto.period_end ?? dateToWire(before.periodEnd);
      if (!isValidPeriod(periodStart, periodEnd)) {
        throw fieldError({ period_end: ['end_before_start'] });
      }
      if (dto.target_value !== undefined) {
        assertTargetFits(type, dto.target_value);
      }
      const rule =
        dto.task_count_rule === undefined ? undefined : ruleFor(type, dto.task_count_rule);
      const unit = dto.unit === undefined ? undefined : await this.unitFor(tx, type, dto.unit);

      const data: Prisma.GoalUncheckedUpdateInput = {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        ...(dto.description === undefined ? {} : { description: emptyToNull(dto.description) }),
        ...(unit === undefined ? {} : { unit }),
        ...(dto.period_start === undefined ? {} : { periodStart: dateValue(dto.period_start) }),
        ...(dto.period_end === undefined ? {} : { periodEnd: dateValue(dto.period_end) }),
        ...(rule === undefined || rule === null
          ? {}
          : { taskCountRule: rule as unknown as Prisma.InputJsonObject }),
        ...(dto.target_value === undefined
          ? {}
          : { targetValue: Decimal.parse(dto.target_value, VALUE_SCALE).toString() }),
      };
      if (Object.keys(data).length > 0) {
        await tx.goal.update({ where: { id }, data });
      }
      let after = await this.ledger.reload(tx, id);
      const actor = this.actor(ctx, origin);

      const old = goalAuditSnapshot(before);
      const next = goalAuditSnapshot(after);
      const changed = diffSnapshots(old, next, GENERAL_FIELDS);
      if (Object.keys(changed.newValues).length > 0) {
        await this.ledger.record(tx, actor, 'GOAL_UPDATED', id, changed);
      }
      if (old['target_value'] !== next['target_value']) {
        events.push(...(await this.ledger.retarget(tx, before, after, actor)));
      }
      // A Task goal's population depends on its period and its rule; either
      // changing re-derives the value (appending history if it moved).
      if (
        isAutomatic(type) &&
        (old['period_start'] !== next['period_start'] ||
          old['period_end'] !== next['period_end'] ||
          old['task_count_rule'] !== next['task_count_rule'])
      ) {
        events.push(...(await this.ledger.recalculate(tx, id, actor, clock)));
      }
      after = await this.ledger.settle(tx, await this.ledger.reload(tx, id), actor, clock);

      return {
        ...(await this.detail(tx, ctx, after, clock)),
        warnings: await this.warningsFor(tx, after),
      };
    });
    await this.events.publish(events);
    return result;
  }

  /**
   * DOCUMENT 14 "Actions": Cancel. DOCUMENT 08 §4.8's `DELETE /goals/{id}` is
   * how it is reached: a goal is history (DOCUMENT 06 §6), so "delete"
   * cancels it — it stays readable, with its history, as `cancelled`.
   */
  async cancel(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'goal.update');
      assertNotCancelled(before);
      await tx.goal.update({ where: { id }, data: { status: 'cancelled' } });
      await this.ledger.record(tx, this.actor(ctx, origin), 'GOAL_CANCELLED', id, {
        oldValues: { status: before.status },
        newValues: { status: 'cancelled' },
      });
    });
  }

  // -- Progress — DOCUMENT 14 rules 3, 5, 6; DOCUMENT 05 FLOW 13 --------------

  async addProgress(
    ctx: AuthContext,
    id: string,
    dto: CreateGoalProgressDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<GoalProgressWritePayload> {
    const events: GoalMilestoneEvent[] = [];
    const result = await this.tenant(ctx, async (tx) => {
      const clock = await this.ledger.clock(tx, now);
      const goal = await this.loadForWrite(tx, ctx, id, 'goal.update_progress');
      assertNotCancelled(goal);
      if (isAutomatic(goal.type as GoalTypeValue)) {
        throw new AppException(ERROR_CODES.GOAL_PROGRESS_AUTOMATIC, 422);
      }
      const appended = await this.ledger.append(
        tx,
        goal,
        { value: dto.value, note: dto.note ?? null, source: 'manual' },
        this.actor(ctx, origin),
        clock,
      );
      events.push(...appended.events);
      return {
        ...(await this.detail(tx, ctx, appended.goal, clock)),
        milestones_crossed: appended.events.map((event) => event.milestone),
      };
    });
    await this.events.publish(events);
    return result;
  }

  // -- Internals ---------------------------------------------------------------

  /**
   * DOCUMENT 09 §4: another company's goal (or one soft-deleted) is a 404 —
   * row-level security has already hidden it; a goal in the tenant but
   * outside the caller's `goal.view` scope is a 403.
   */
  private async loadVisible(tx: TenantClient, ctx: AuthContext, id: string): Promise<GoalRow> {
    const row = await tx.goal.findFirst({
      where: { id, deletedAt: null },
      include: GOAL_INCLUDE,
    });
    if (row === null) {
      throw notFound();
    }
    await this.requireScope(tx, ctx, id, 'goal.view');
    return row;
  }

  private async requireScope(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: 'goal.view' | GoalPermission,
  ): Promise<void> {
    const reachable = await tx.goal.findFirst({
      where: { AND: [{ id }, goalScopeWhere(ctx, permission)] },
      select: { id: true },
    });
    if (reachable === null) {
      throw forbidden();
    }
  }

  /** Visible, reachable by the action, and locked for the rest of the transaction. */
  private async loadForWrite(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: GoalPermission,
  ): Promise<GoalRow> {
    await this.loadVisible(tx, ctx, id);
    await this.requireScope(tx, ctx, id, permission);
    const locked = await this.ledger.lock(tx, id);
    if (locked === null) {
      throw notFound();
    }
    return locked;
  }

  private async canReach(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: GoalPermission,
  ): Promise<boolean> {
    if (!hasGoalScope(ctx, permission)) {
      return false;
    }
    const reachable = await tx.goal.findFirst({
      where: { AND: [{ id }, goalScopeWhere(ctx, permission)] },
      select: { id: true },
    });
    return reachable !== null;
  }

  private async detail(
    tx: TenantClient,
    ctx: AuthContext,
    row: GoalRow,
    clock: CompanyClock,
  ): Promise<GoalDetailPayload> {
    const type = row.type as GoalTypeValue;
    const open = row.status !== 'cancelled';
    const [canEdit, canProgress] = await Promise.all([
      this.canReach(tx, ctx, row.id, 'goal.update'),
      this.canReach(tx, ctx, row.id, 'goal.update_progress'),
    ]);

    // The linked tasks the caller may themselves see; a caller without
    // `task.view` sees none rather than learning about tasks by another route.
    let taskScope: Prisma.TaskWhereInput | null = null;
    try {
      taskScope = taskScopeWhere(ctx, 'task.view');
    } catch (error) {
      if (!(error instanceof AppException)) {
        throw error;
      }
    }
    const tasks =
      taskScope === null
        ? []
        : await tx.task.findMany({
            where: { AND: [{ goalId: row.id, deletedAt: null }, taskScope] },
            select: {
              id: true,
              title: true,
              status: true,
              priority: true,
              deadline: true,
              completedAt: true,
            },
            orderBy: [{ completedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
          });

    let counting = new Set<string>();
    let misconfigured = false;
    const rule = parseTaskCountRule(row.taskCountRule);
    if (isAutomatic(type) && rule !== null) {
      const { closesOn } = goalMeasures(row);
      const qualifying = await tx.task.findMany({
        where: this.ledger.qualifyingWhere(row, rule.priorities, closesOn, clock.timeZone),
        select: { id: true },
      });
      counting = new Set(qualifying.map((task) => task.id));
      // DOCUMENT 14 edge case: a Task goal with no task that could ever count —
      // nothing linked, uncancelled and of a counted priority — is flagged.
      const candidates = await tx.task.count({
        where: {
          goalId: row.id,
          deletedAt: null,
          status: { not: 'cancelled' },
          priority: { in: [...rule.priorities] },
        },
      });
      misconfigured = candidates === 0;
    }

    return goalDetailPayload(row, clock.today, {
      linked_tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status as TaskStatusValue,
        priority: task.priority as TaskPriorityValue,
        deadline: task.deadline === null ? null : dateToWire(task.deadline),
        completed_at: task.completedAt?.toISOString() ?? null,
        counts: counting.has(task.id),
      })),
      possibly_misconfigured: misconfigured,
      abilities: {
        can_edit: open && canEdit,
        can_update_progress: open && canProgress && !isAutomatic(type),
        can_cancel: open && canEdit,
      },
    });
  }

  /**
   * DOCUMENT 14 validation: "Owner must be an active employee within the
   * caller's scope". Outside the scope reads as not found; inactive is named.
   */
  private async requireOwner(
    tx: TenantClient,
    ctx: AuthContext,
    employeeId: string,
  ): Promise<string> {
    const employee = await tx.employee.findFirst({
      where: { AND: [{ id: employeeId, deletedAt: null }, employeeScopeWhere(ctx, 'goal.create')] },
      select: { id: true, status: true },
    });
    if (employee === null) {
      throw fieldError({ employee_id: ['not_found'] });
    }
    if (employee.status !== 'active') {
      throw fieldError({ employee_id: ['not_active'] });
    }
    return employee.id;
  }

  /**
   * DOCUMENT 14 validation: "Sales goals require a currency unit" — the
   * company's currency (A-02: one currency per company), filled in when the
   * caller leaves it out and refused when it names another. A Task goal counts
   * tasks. A Custom goal's unit is the caller's ("%", "points", …).
   */
  private async unitFor(
    tx: TenantClient,
    type: GoalTypeValue,
    unit: string | undefined,
  ): Promise<string> {
    switch (type) {
      case 'task':
        if (unit !== undefined && unit !== TASK_GOAL_UNIT) {
          throw fieldError({ unit: ['invalid'] });
        }
        return TASK_GOAL_UNIT;
      case 'sales': {
        // Omitted, it is the company's currency — the only one it may be.
        const company = await tx.company.findFirstOrThrow({ select: { currency: true } });
        if (unit !== undefined && unit.toUpperCase() !== company.currency) {
          throw fieldError({ unit: ['invalid'] });
        }
        return company.currency;
      }
      case 'custom':
        if (unit === undefined) {
          throw fieldError({ unit: ['required'] });
        }
        return unit;
    }
  }

  /** DOCUMENT 14 rule 8: overlapping goals of the same type are allowed, and warned. */
  private async warningsFor(tx: TenantClient, goal: GoalRow): Promise<readonly GoalWriteWarning[]> {
    if (goal.status === 'cancelled') {
      return [];
    }
    const overlapping = await tx.goal.count({
      where: {
        id: { not: goal.id },
        employeeId: goal.employeeId,
        type: goal.type,
        deletedAt: null,
        status: { not: 'cancelled' },
        periodStart: { lte: goal.periodEnd },
        periodEnd: { gte: goal.periodStart },
      },
    });
    return overlapping > 0 ? ['overlapping_goal'] : [];
  }

  private actor(ctx: AuthContext, origin: RequestOrigin): GoalActor {
    return { companyId: ctx.companyId, userId: ctx.userId, origin };
  }
}

/** DOCUMENT 14 "Error states": "Progress update on a cancelled goal — 422". Edits too. */
function assertNotCancelled(goal: GoalRow): void {
  if (goal.status === 'cancelled') {
    throw new AppException(ERROR_CODES.GOAL_CANCELLED, 422);
  }
}

/**
 * DOCUMENT 14 validation: "Task goals require a `task_count_rule`" — omitted,
 * every linked task counts. Any other type takes none.
 */
function ruleFor(
  type: GoalTypeValue,
  input: Record<string, unknown> | undefined,
): TaskCountRule | null {
  if (type !== 'task') {
    if (input !== undefined) {
      throw fieldError({ task_count_rule: ['invalid'] });
    }
    return null;
  }
  if (input === undefined) {
    return DEFAULT_TASK_COUNT_RULE;
  }
  const rule = parseTaskCountRule(input);
  if (rule === null) {
    throw fieldError({ task_count_rule: ['invalid'] });
  }
  return rule;
}

/** A Task goal's target is a number of tasks — a whole number. */
function assertTargetFits(type: GoalTypeValue, target: string): void {
  if (type === 'task') {
    // Exact at scale 0, or it is not a whole number of tasks.
    if (Decimal.parse(target, VALUE_SCALE).units % 10n ** BigInt(VALUE_SCALE) !== 0n) {
      throw fieldError({ target_value: ['invalid'] });
    }
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
