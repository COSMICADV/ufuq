/**
 * Tasks, checklists and progress updates — DOCUMENT 13, DOCUMENT 08 §4.7,
 * DOCUMENT 05 FLOWS 09–11.
 *
 * The rules that carry the weight, each applied here and written in
 * `task-rules.ts` only once:
 *
 *   - **Progress is derived** on every write that can change it — a tick, an
 *     untick, an item added or removed, a status change — inside the same
 *     transaction, with the task row locked. It is never accepted from a
 *     client (DOCUMENT 06 §1.3).
 *   - **Status transitions are validated server-side** against DOCUMENT 13
 *     rule 4. An invalid one is a 422 naming the allowed transitions; a
 *     same-status request is invalid too, not a silent no-op.
 *   - **First activity** — the first tick or the first progress note — moves
 *     `not_started` to `in_progress` (rule 5), audited as a status change.
 *   - **Scope**: a task outside the caller's `task.view` scope is a 404
 *     (DOCUMENT 13 "Error states", approved Phase 7 decision); a visible task
 *     the action's own scope does not reach is a 403.
 *   - **Audit**: every DOCUMENT 21 task action is written in the same
 *     transaction as the change it describes.
 *
 *   - **Goal link — rule 8 (Phase 8).** A task may link to a goal of the same
 *     company and the same employee (DOCUMENT 13 validation). Any change that
 *     can move a Task goal's count — completing, reopening, cancelling or
 *     deleting a linked task, relinking it, changing its priority — asks the
 *     goal ledger to re-derive that goal **in the same transaction**; the
 *     ledger appends history, audits, and returns any milestones crossed,
 *     which are published only after the commit. No goal rule is restated
 *     here (DOCUMENT 27 RULE 6).
 *
 * Deferred by phase, not forgotten (docs/PHASE-7-STATUS.md): notifications to
 * assignees (Phase 15). Attachments are the generic store's
 * (`src/attachments/`); `findOne` reads them through `AttachmentsService`.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { AuditAction, Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AttachmentsService } from '../attachments/attachments.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { calendarDateIn, formatCalendarDate } from '../attendance/zoned-time.js';
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
import { diffSnapshots } from '../employees/employee-payload.js';
import { employeeScopeWhere } from '../employees/employee-query.js';
import { GoalEventPublisher } from '../goals/goal-events.js';
import type { GoalMilestoneEvent } from '../goals/goal-events.js';
import { GoalLedgerService } from '../goals/goal-ledger.service.js';
import type { GoalActor } from '../goals/goal-ledger.service.js';
import { goalScopeWhere } from '../goals/goal-query.js';

import type {
  ChangeTaskStatusDto,
  CreateChecklistItemDto,
  CreateProgressUpdateDto,
  CreateTaskDto,
  ListTasksQueryDto,
  ProgressUpdatesQueryDto,
  UpdateChecklistItemDto,
  UpdateTaskDto,
} from './dto/task.dto.js';
import {
  PROGRESS_UPDATE_INCLUDE,
  TASK_DETAIL_INCLUDE,
  TASK_LIST_INCLUDE,
  percentToWire,
  progressUpdatePayload,
  taskAuditSnapshot,
  taskDetailPayload,
  taskPayload,
} from './task-payload.js';
import type {
  ProgressUpdatePayload,
  TaskAuditSnapshot,
  TaskDetailPayload,
  TaskWithAttachmentsPayload,
  TaskDetailRow,
  TaskPayload,
} from './task-payload.js';
import {
  LIST_ORDER,
  dateValue,
  forbidden,
  listWhere,
  overdueWhere,
  taskScopeWhere,
} from './task-query.js';
import {
  OPEN_STATUSES,
  TASK_STATUSES,
  allowedTransitions,
  computeProgress,
  isAllowedTransition,
  isReopen,
  statusAfterFirstActivity,
  transitionRequiresReason,
} from './task-rules.js';
import type { TaskStatusValue } from './task-rules.js';

export interface TaskList {
  readonly items: readonly TaskPayload[];
  readonly total: number;
}

export interface ProgressUpdateList {
  readonly items: readonly ProgressUpdatePayload[];
  readonly total: number;
}

/** `GET /tasks/summary` — the dashboard counts (DOCUMENT 04 A-dashboard, C-home). */
export interface TaskSummary {
  readonly total: number;
  readonly by_status: Readonly<Record<TaskStatusValue, number>>;
  readonly overdue: number;
  readonly due_today: number;
}

/**
 * DOCUMENT 13 edge case "Task linked to a goal outside its period": warned at
 * creation (and on edit); the task does not contribute to that goal.
 */
export type TaskWriteWarning = 'goal_outside_period';

/** `POST /tasks` and `PATCH /tasks/{id}` — the task, with any warning about its goal link. */
export interface TaskWritePayload extends TaskDetailPayload {
  readonly warnings: readonly TaskWriteWarning[];
}

/** DOCUMENT 21 general-edit fields; assignee and deadline have their own actions. */
const GENERAL_FIELDS = [
  'title',
  'description',
  'department_id',
  'priority',
  'start_date',
  'goal_id',
] as const;

/** A goal a task may link to — DOCUMENT 13 validation. */
interface LinkableGoal {
  readonly id: string;
  readonly status: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

type TaskPermission =
  | 'task.update'
  | 'task.delete'
  | 'task.update_status'
  | 'task.update_checklist'
  | 'task.add_progress_note';

@Injectable()
export class TasksService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(GoalLedgerService) private readonly goalLedger: GoalLedgerService,
    @Inject(GoalEventPublisher) private readonly goalEvents: GoalEventPublisher,
  ) {
    super(prisma);
  }

  // -- Reads -----------------------------------------------------------------

  async list(ctx: AuthContext, query: ListTasksQueryDto, now = new Date()): Promise<TaskList> {
    const scope = taskScopeWhere(ctx, 'task.view');
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      const today = await this.today(tx, now);
      const where = listWhere(scope, query, today);
      const [rows, total] = await Promise.all([
        tx.task.findMany({
          where,
          include: TASK_LIST_INCLUDE,
          orderBy: LIST_ORDER,
          skip: page.skip,
          take: page.take,
        }),
        tx.task.count({ where }),
      ]);
      return { items: rows.map((row) => taskPayload(row, today)), total };
    });
  }

  async summary(ctx: AuthContext, now = new Date()): Promise<TaskSummary> {
    const scope = taskScopeWhere(ctx, 'task.view');
    return this.tenant(ctx, async (tx) => {
      const today = await this.today(tx, now);
      const base: Prisma.TaskWhereInput = { AND: [{ deletedAt: null }, scope] };
      const [grouped, overdue, dueToday] = await Promise.all([
        tx.task.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
        tx.task.count({ where: { AND: [base, overdueWhere(today)] } }),
        tx.task.count({
          where: {
            AND: [base, { deadline: dateValue(today), status: { in: [...OPEN_STATUSES] } }],
          },
        }),
      ]);
      const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<
        TaskStatusValue,
        number
      >;
      for (const group of grouped) {
        byStatus[group.status as TaskStatusValue] = group._count._all;
      }
      return {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        by_status: byStatus,
        overdue,
        due_today: dueToday,
      };
    });
  }

  /**
   * The task, its checklist, and its live attachments with what the caller may
   * do with them. `loadVisible` has already applied `task.view` scope, so the
   * attachment list is read for a task the caller is entitled to see.
   */
  async findOne(
    ctx: AuthContext,
    id: string,
    now = new Date(),
  ): Promise<TaskWithAttachmentsPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await this.loadVisible(tx, ctx, id);
      const [items, abilities] = await Promise.all([
        this.attachments.listFor(tx, 'task', id),
        this.attachments.abilitiesFor(tx, ctx, 'task', id),
      ]);
      return {
        ...taskDetailPayload(row, await this.today(tx, now)),
        attachments: {
          items,
          can_upload: abilities.canUpload,
          can_delete: abilities.canDelete,
        },
      };
    });
  }

  async listProgressUpdates(
    ctx: AuthContext,
    id: string,
    query: ProgressUpdatesQueryDto,
  ): Promise<ProgressUpdateList> {
    const page = resolvePage(query);
    return this.tenant(ctx, async (tx) => {
      await this.loadVisible(tx, ctx, id);
      const [rows, total] = await Promise.all([
        tx.taskProgressUpdate.findMany({
          where: { taskId: id },
          include: PROGRESS_UPDATE_INCLUDE,
          // Newest first — a timeline reads from the latest entry down.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.taskProgressUpdate.count({ where: { taskId: id } }),
      ]);
      return { items: rows.map(progressUpdatePayload), total };
    });
  }

  // -- Create / edit / delete ------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateTaskDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TaskWritePayload> {
    assertDateOrder(dto.start_date ?? null, dto.deadline ?? null);
    const checklist = dto.checklist ?? [];

    return this.tenant(ctx, async (tx) => {
      const assignee = await this.requireAssignee(tx, ctx, dto.assignee_employee_id, 'task.create');
      const departmentId =
        dto.department_id === undefined ? assignee.departmentId : dto.department_id;
      if (dto.department_id !== undefined && dto.department_id !== null) {
        await this.requireDepartment(tx, dto.department_id);
      }
      const goal =
        dto.goal_id === undefined || dto.goal_id === null
          ? null
          : await this.requireLinkableGoal(tx, ctx, dto.goal_id, assignee.id);

      const id = generateId();
      await tx.task.create({
        data: {
          id,
          companyId: ctx.companyId,
          title: dto.title,
          description: emptyToNull(dto.description),
          assigneeEmployeeId: assignee.id,
          departmentId,
          priority: dto.priority,
          // FLOW 09: "save → status = Not Started, progress = 0%".
          status: 'not_started',
          startDate: dto.start_date ? dateValue(dto.start_date) : null,
          deadline: dto.deadline ? dateValue(dto.deadline) : null,
          goalId: goal?.id ?? null,
          progressPercent: computeProgress({
            status: 'not_started',
            totalItems: checklist.length,
            completedItems: 0,
            currentPercent: '0.00',
          }),
          createdBy: ctx.userId,
        },
      });
      if (checklist.length > 0) {
        await tx.taskChecklistItem.createMany({
          data: checklist.map((title, position) => ({
            id: generateId(),
            taskId: id,
            title,
            position,
          })),
        });
      }

      const row = await this.reload(tx, id);
      await this.record(tx, ctx, origin, 'TASK_CREATED', id, {
        newValues: { ...taskAuditSnapshot(row), checklist_items: String(checklist.length) },
      });
      // A new task is never completed, so no goal's count moves here.
      return {
        ...taskDetailPayload(row, await this.today(tx, now)),
        warnings: goalWarnings(goal, dto.deadline ?? null),
      };
    });
  }

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateTaskDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TaskWritePayload> {
    const events: GoalMilestoneEvent[] = [];
    const result = await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.update');

      if (
        dto.assignee_employee_id !== undefined &&
        dto.assignee_employee_id !== before.assigneeEmployeeId
      ) {
        await this.requireAssignee(tx, ctx, dto.assignee_employee_id, 'task.update');
      }
      if (
        dto.department_id !== undefined &&
        dto.department_id !== null &&
        dto.department_id !== before.departmentId
      ) {
        await this.requireDepartment(tx, dto.department_id);
      }
      const startDate =
        dto.start_date === undefined ? wireDate(before.startDate) : (dto.start_date ?? null);
      const deadline =
        dto.deadline === undefined ? wireDate(before.deadline) : (dto.deadline ?? null);
      assertDateOrder(startDate, deadline);

      // DOCUMENT 13 validation: the linked goal must belong to the assignee.
      // Checked whenever either side of that pair changes, so reassigning a
      // linked task to someone else also requires relinking or unlinking it.
      const assigneeId = dto.assignee_employee_id ?? before.assigneeEmployeeId;
      const goalId = dto.goal_id === undefined ? before.goalId : dto.goal_id;
      const goal =
        goalId !== null && (goalId !== before.goalId || assigneeId !== before.assigneeEmployeeId)
          ? await this.requireLinkableGoal(tx, ctx, goalId, assigneeId)
          : null;

      const data: Prisma.TaskUncheckedUpdateInput = {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        ...(dto.description === undefined ? {} : { description: emptyToNull(dto.description) }),
        ...(dto.assignee_employee_id === undefined
          ? {}
          : { assigneeEmployeeId: dto.assignee_employee_id }),
        ...(dto.department_id === undefined ? {} : { departmentId: dto.department_id }),
        ...(dto.priority === undefined ? {} : { priority: dto.priority }),
        ...(dto.start_date === undefined
          ? {}
          : { startDate: dto.start_date === null ? null : dateValue(dto.start_date) }),
        ...(dto.deadline === undefined
          ? {}
          : { deadline: dto.deadline === null ? null : dateValue(dto.deadline) }),
        ...(dto.goal_id === undefined ? {} : { goalId: dto.goal_id }),
      };
      if (Object.keys(data).length > 0) {
        await tx.task.update({ where: { id }, data });
      }

      const after = await this.reload(tx, id);
      const old = taskAuditSnapshot(before);
      const next = taskAuditSnapshot(after);
      // DOCUMENT 21: one record per kind of change, so "who reassigned this?"
      // and "who moved the deadline?" are each one query.
      await this.recordDiff(tx, ctx, origin, 'TASK_UPDATED', id, old, next, GENERAL_FIELDS);
      // Rule 10: reassignment is audited (the notification half is Phase 15).
      await this.recordDiff(tx, ctx, origin, 'TASK_REASSIGNED', id, old, next, [
        'assignee_employee_id',
      ]);
      // Rule 11 asks for deadline changes on an overdue task; every deadline
      // change is recorded, which includes those, with old and new values.
      await this.recordDiff(tx, ctx, origin, 'TASK_DEADLINE_CHANGED', id, old, next, ['deadline']);

      // Rule 8: a relink or a priority change can move a Task goal's count —
      // the goal it left and the goal it joined are both re-derived.
      if (old['goal_id'] !== next['goal_id'] || old['priority'] !== next['priority']) {
        events.push(...(await this.syncGoals(tx, ctx, origin, now, [before.goalId, after.goalId])));
      }

      return {
        ...taskDetailPayload(after, await this.today(tx, now)),
        warnings: goalWarnings(goal, deadline),
      };
    });
    await this.goalEvents.publish(events);
    return result;
  }

  /** Soft delete — DOCUMENT 06 §6, DOCUMENT 08 §4.7. */
  async remove(
    ctx: AuthContext,
    id: string,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<void> {
    const events = await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.delete');
      await tx.task.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.record(tx, ctx, origin, 'TASK_DELETED', id, {
        oldValues: { title: before.title, status: before.status },
        newValues: { deleted: 'true' },
      });
      // A deleted task no longer counts toward a Task goal (rule 8).
      return this.syncGoals(tx, ctx, origin, now, [before.goalId]);
    });
    await this.goalEvents.publish(events);
  }

  // -- Status — DOCUMENT 13 rules 4, 6, 7 ------------------------------------

  async changeStatus(
    ctx: AuthContext,
    id: string,
    dto: ChangeTaskStatusDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TaskDetailPayload> {
    const events: GoalMilestoneEvent[] = [];
    const result = await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.update_status');
      const from = before.status as TaskStatusValue;
      const to = dto.status;

      if (!isAllowedTransition(from, to)) {
        throw invalidTransition(from);
      }
      const reason = dto.reason?.trim() ?? '';
      if (transitionRequiresReason(from, to) && reason === '') {
        throw fieldError({ reason: ['required'] });
      }
      if (to === 'completed') {
        const open = before.checklistItems.filter((item) => !item.isCompleted).length;
        if (open > 0 && dto.confirm_open_items !== true) {
          // Rule 6: the count travels with the refusal so the confirmation
          // can name it ("3 items are still open. Complete anyway?").
          throw new AppException(ERROR_CODES.TASK_HAS_OPEN_ITEMS, 409, {
            fields: { open_items: [String(open)] },
          });
        }
      }

      await tx.task.update({
        where: { id },
        data: {
          status: to,
          completedAt: to === 'completed' ? now : null,
          ...(to === 'cancelled' ? { cancelledReason: reason } : {}),
          progressPercent: progressFor(before, to),
        },
      });
      const after = await this.reload(tx, id);

      const old = taskAuditSnapshot(before);
      const next = taskAuditSnapshot(after);
      const changed = diffSnapshots(old, next, ['status', 'progress_percent', 'cancelled_reason']);
      const action: AuditAction =
        to === 'cancelled'
          ? 'TASK_CANCELLED'
          : isReopen(from, to)
            ? 'TASK_REOPENED'
            : 'TASK_STATUS_CHANGED';
      await this.record(tx, ctx, origin, action, id, {
        oldValues: changed.oldValues,
        // A reopen's reason has no column (DOCUMENT 06 §3.15); the audit trail
        // is where it is kept — the Phase 6 adjustment-reason pattern.
        newValues: isReopen(from, to) ? { ...changed.newValues, reason } : changed.newValues,
      });
      // Rule 8 and its edge case: completing a linked task raises its Task
      // goal; reopening it recalculates the goal downward — in this same
      // transaction, audited by the ledger.
      events.push(...(await this.syncGoals(tx, ctx, origin, now, [after.goalId])));
      return taskDetailPayload(after, await this.today(tx, now));
    });
    await this.goalEvents.publish(events);
    return result;
  }

  // -- Checklist — DOCUMENT 05 FLOW 11 ---------------------------------------

  async addChecklistItem(
    ctx: AuthContext,
    id: string,
    dto: CreateChecklistItemDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TaskDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.update');
      const last = before.checklistItems.at(-1);
      const itemId = generateId();
      await tx.taskChecklistItem.create({
        data: { id: itemId, taskId: id, title: dto.title, position: (last?.position ?? -1) + 1 },
      });
      const after = await this.recalculate(tx, id, before);
      await this.record(tx, ctx, origin, 'CHECKLIST_ITEM_ADDED', id, {
        oldValues: { progress_percent: percentToWire(before.progressPercent) },
        newValues: {
          checklist_item_id: itemId,
          title: dto.title,
          progress_percent: percentToWire(after.progressPercent),
        },
      });
      return taskDetailPayload(after, await this.today(tx, now));
    });
  }

  async updateChecklistItem(
    ctx: AuthContext,
    id: string,
    itemId: string,
    dto: UpdateChecklistItemDto,
    origin: RequestOrigin,
    now = new Date(),
  ): Promise<TaskDetailPayload> {
    if (dto.is_completed === undefined && dto.title === undefined && dto.position === undefined) {
      throw fieldError({ is_completed: ['required'] });
    }
    return this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.update_checklist');
      // Editing and reordering the list is Admin/Manager work (DOCUMENT 13
      // "Actions"); ticking is the assignee's. Same scope order as above.
      if (dto.title !== undefined || dto.position !== undefined) {
        await this.requireActionScope(tx, ctx, id, 'task.update');
      }
      const item = before.checklistItems.find((candidate) => candidate.id === itemId);
      if (item === undefined) {
        throw notFound();
      }

      if (dto.title !== undefined && dto.title !== item.title) {
        await tx.taskChecklistItem.update({ where: { id: itemId }, data: { title: dto.title } });
        await this.record(tx, ctx, origin, 'TASK_UPDATED', id, {
          oldValues: { checklist_item_id: itemId, title: item.title },
          newValues: { checklist_item_id: itemId, title: dto.title },
        });
      }

      if (dto.position !== undefined) {
        const order = before.checklistItems.filter((candidate) => candidate.id !== itemId);
        const target = Math.min(dto.position, order.length);
        const from = before.checklistItems.findIndex((candidate) => candidate.id === itemId);
        if (target !== from) {
          order.splice(target, 0, item);
          // Renumbered 0…n-1 in the new order: positions stay dense, so the
          // next appended item is simply "last + 1".
          for (const [position, candidate] of order.entries()) {
            if (candidate.position !== position) {
              await tx.taskChecklistItem.update({
                where: { id: candidate.id },
                data: { position },
              });
            }
          }
          await this.record(tx, ctx, origin, 'TASK_UPDATED', id, {
            oldValues: { checklist_item_id: itemId, position: String(from) },
            newValues: { checklist_item_id: itemId, position: String(target) },
          });
        }
      }

      let after: TaskDetailRow = before;
      // DOCUMENT 13 edge case: two people ticking the same item at once —
      // "last write wins; the item's completed state is idempotent so no error
      // is shown". Ticking a ticked item is therefore success with no change.
      if (dto.is_completed !== undefined && dto.is_completed !== item.isCompleted) {
        await tx.taskChecklistItem.update({
          where: { id: itemId },
          data: dto.is_completed
            ? { isCompleted: true, completedAt: now, completedBy: ctx.userId }
            : { isCompleted: false, completedAt: null, completedBy: null },
        });
        // Rule 5: the first tick starts the task. An untick never does.
        const status = dto.is_completed
          ? statusAfterFirstActivity(before.status as TaskStatusValue)
          : undefined;
        after = await this.recalculate(tx, id, before, status);
        await this.record(tx, ctx, origin, 'TASK_UPDATED', id, {
          oldValues: {
            checklist_item_id: itemId,
            is_completed: String(item.isCompleted),
            progress_percent: percentToWire(before.progressPercent),
          },
          newValues: {
            checklist_item_id: itemId,
            is_completed: String(dto.is_completed),
            progress_percent: percentToWire(after.progressPercent),
          },
        });
        await this.recordAutoStart(tx, ctx, origin, before, after);
      }

      return taskDetailPayload(await this.reload(tx, id), await this.today(tx, now));
    });
  }

  async removeChecklistItem(
    ctx: AuthContext,
    id: string,
    itemId: string,
    origin: RequestOrigin,
  ): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.update');
      const item = before.checklistItems.find((candidate) => candidate.id === itemId);
      if (item === undefined) {
        throw notFound();
      }
      await tx.taskChecklistItem.delete({ where: { id: itemId } });
      // FLOW 11: "denominator decreases, progress recalculated". With no
      // items left, the OD-10 status rule takes over (no division by zero).
      const after = await this.recalculate(tx, id, before);
      await this.record(tx, ctx, origin, 'CHECKLIST_ITEM_DELETED', id, {
        oldValues: {
          checklist_item_id: itemId,
          title: item.title,
          is_completed: String(item.isCompleted),
          progress_percent: percentToWire(before.progressPercent),
        },
        newValues: { progress_percent: percentToWire(after.progressPercent) },
      });
    });
  }

  // -- Progress updates — DOCUMENT 13 rules 5 and 9 ---------------------------

  async addProgressUpdate(
    ctx: AuthContext,
    id: string,
    dto: CreateProgressUpdateDto,
    origin: RequestOrigin,
  ): Promise<ProgressUpdatePayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await this.loadForWrite(tx, ctx, id, 'task.add_progress_note');
      // Rule 5: the first progress note starts the task, exactly as a tick does.
      const after = await this.recalculate(
        tx,
        id,
        before,
        statusAfterFirstActivity(before.status as TaskStatusValue),
      );
      await this.recordAutoStart(tx, ctx, origin, before, after);

      const row = await tx.taskProgressUpdate.create({
        data: {
          id: generateId(),
          taskId: id,
          employeeId: ctx.callerEmployeeId,
          note: dto.note,
          progressPercentAtTime: after.progressPercent,
          createdBy: ctx.userId,
        },
        include: PROGRESS_UPDATE_INCLUDE,
      });
      return progressUpdatePayload(row);
    });
  }

  // -- Internals ---------------------------------------------------------------

  /** Re-derive the Task goals a change touched, as the acting user. */
  private async syncGoals(
    tx: TenantClient,
    ctx: AuthContext,
    origin: RequestOrigin,
    now: Date,
    goalIds: readonly (string | null)[],
  ): Promise<readonly GoalMilestoneEvent[]> {
    if (goalIds.every((goalId) => goalId === null)) {
      return [];
    }
    const actor: GoalActor = { companyId: ctx.companyId, userId: ctx.userId, origin };
    return this.goalLedger.afterTaskChange(
      tx,
      goalIds,
      actor,
      await this.goalLedger.clock(tx, now),
    );
  }

  /**
   * DOCUMENT 13 validation: "Linked goal must belong to the same company and,
   * when employee-scoped, the same employee." Every V1 goal is
   * employee-scoped. A goal the caller cannot see reads as not found (row
   * security has already hidden another company's); a cancelled goal takes
   * no new work (DOCUMENT 14 "Error states").
   */
  private async requireLinkableGoal(
    tx: TenantClient,
    ctx: AuthContext,
    goalId: string,
    assigneeId: string,
  ): Promise<LinkableGoal> {
    let scope: Prisma.GoalWhereInput;
    try {
      scope = goalScopeWhere(ctx, 'goal.view');
    } catch (error) {
      if (error instanceof AppException) {
        throw fieldError({ goal_id: ['not_found'] });
      }
      throw error;
    }
    const goal = await tx.goal.findFirst({
      where: { AND: [{ id: goalId, deletedAt: null }, scope] },
      select: { id: true, status: true, employeeId: true, periodStart: true, periodEnd: true },
    });
    if (goal === null) {
      throw fieldError({ goal_id: ['not_found'] });
    }
    if (goal.status === 'cancelled') {
      throw fieldError({ goal_id: ['cancelled'] });
    }
    if (goal.employeeId !== assigneeId) {
      throw fieldError({ goal_id: ['not_same_employee'] });
    }
    return goal;
  }

  /** The company's calendar day — overdue is measured against it (rule 1). */
  private async today(tx: TenantClient, now: Date): Promise<string> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    return formatCalendarDate(calendarDateIn(now, company.timezone));
  }

  /**
   * DOCUMENT 13 "Error states": a task that does not exist, is soft-deleted,
   * belongs to another company or lies outside the caller's `task.view` scope
   * is the same 404 — the approved Phase 7 decision. The scope is part of the
   * query, never a filter applied afterwards (DOCUMENT 09 §4).
   */
  private async loadVisible(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<TaskDetailRow> {
    const row = await tx.task.findFirst({
      where: { AND: [{ id, deletedAt: null }, taskScopeWhere(ctx, 'task.view')] },
      include: TASK_DETAIL_INCLUDE,
    });
    if (row === null) {
      throw notFound();
    }
    return row;
  }

  /** DOCUMENT 09 §4 check 4: the action's own scope must reach this visible task. */
  private async requireActionScope(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: TaskPermission,
  ): Promise<void> {
    const reachable = await tx.task.findFirst({
      where: { AND: [{ id }, taskScopeWhere(ctx, permission)] },
      select: { id: true },
    });
    if (reachable === null) {
      throw forbidden();
    }
  }

  /**
   * `loadVisible` and `requireActionScope`, with the task row locked for the
   * rest of the transaction: progress is a function of the checklist, and two
   * concurrent ticks must each recompute it from the other's committed state.
   */
  private async loadForWrite(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
    permission: TaskPermission,
  ): Promise<TaskDetailRow> {
    await tx.$executeRaw`SELECT 1 FROM tasks WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await this.loadVisible(tx, ctx, id);
    await this.requireActionScope(tx, ctx, id, permission);
    return row;
  }

  private reload(tx: TenantClient, id: string): Promise<TaskDetailRow> {
    return tx.task.findUniqueOrThrow({ where: { id }, include: TASK_DETAIL_INCLUDE });
  }

  /**
   * Re-derive progress from the checklist as it now stands (and optionally
   * move the status), and write both. The single place a stored progress
   * value is produced after creation.
   */
  private async recalculate(
    tx: TenantClient,
    id: string,
    before: TaskDetailRow,
    status: TaskStatusValue = before.status as TaskStatusValue,
  ): Promise<TaskDetailRow> {
    const [totalItems, completedItems] = await Promise.all([
      tx.taskChecklistItem.count({ where: { taskId: id } }),
      tx.taskChecklistItem.count({ where: { taskId: id, isCompleted: true } }),
    ]);
    const progressPercent = computeProgress({
      status,
      totalItems,
      completedItems,
      currentPercent: percentToWire(before.progressPercent),
    });
    if (status !== before.status || progressPercent !== percentToWire(before.progressPercent)) {
      await tx.task.update({ where: { id }, data: { status, progressPercent } });
    }
    return this.reload(tx, id);
  }

  /** Rule 5's automatic move, audited as the status change it is. */
  private async recordAutoStart(
    tx: TenantClient,
    ctx: AuthContext,
    origin: RequestOrigin,
    before: TaskDetailRow,
    after: TaskDetailRow,
  ): Promise<void> {
    if (before.status === after.status) {
      return;
    }
    await this.record(tx, ctx, origin, 'TASK_STATUS_CHANGED', before.id, {
      oldValues: { status: before.status, progress_percent: percentToWire(before.progressPercent) },
      newValues: { status: after.status, progress_percent: percentToWire(after.progressPercent) },
    });
  }

  /**
   * DOCUMENT 13 validation: "Assignee must be an active employee within the
   * caller's scope". Outside the scope reads as not found — a manager is not
   * told about employees outside their team; inactive is named, so the screen
   * can say "الموظف غير نشط" and suggest someone else (DOCUMENT 13 errors).
   */
  private async requireAssignee(
    tx: TenantClient,
    ctx: AuthContext,
    employeeId: string,
    permission: 'task.create' | 'task.update',
  ): Promise<{ readonly id: string; readonly departmentId: string | null }> {
    const employee = await tx.employee.findFirst({
      where: { AND: [{ id: employeeId, deletedAt: null }, employeeScopeWhere(ctx, permission)] },
      select: { id: true, status: true, departmentId: true },
    });
    if (employee === null) {
      throw fieldError({ assignee_employee_id: ['not_found'] });
    }
    if (employee.status !== 'active') {
      throw fieldError({ assignee_employee_id: ['not_active'] });
    }
    return employee;
  }

  private async requireDepartment(tx: TenantClient, departmentId: string): Promise<void> {
    const department = await tx.department.findFirst({
      where: { id: departmentId, deletedAt: null },
      select: { id: true },
    });
    if (department === null) {
      throw fieldError({ department_id: ['not_found'] });
    }
  }

  private async record(
    tx: TenantClient,
    ctx: AuthContext,
    origin: RequestOrigin,
    action: AuditAction,
    taskId: string,
    values: { oldValues?: Prisma.InputJsonObject; newValues?: Prisma.InputJsonObject },
  ): Promise<void> {
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action,
      // Every task action — checklist ones included — is recorded against the
      // task, so the task's history panel (DOCUMENT 21) is one entity query.
      entityType: 'task',
      entityId: taskId,
      ...values,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }

  private async recordDiff(
    tx: TenantClient,
    ctx: AuthContext,
    origin: RequestOrigin,
    action: AuditAction,
    taskId: string,
    before: TaskAuditSnapshot,
    after: TaskAuditSnapshot,
    keys: readonly string[],
  ): Promise<void> {
    const changed = diffSnapshots(before, after, keys);
    if (Object.keys(changed.newValues).length > 0) {
      await this.record(tx, ctx, origin, action, taskId, changed);
    }
  }
}

/** 422 "explaining the allowed transitions" — DOCUMENT 13 "Error states". */
function invalidTransition(from: TaskStatusValue): AppException {
  return new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 422, {
    fields: { status: ['invalid_transition'], allowed_transitions: [...allowedTransitions(from)] },
  });
}

/** The progress a status change leaves behind — the checklist, else OD-10. */
function progressFor(task: TaskDetailRow, status: TaskStatusValue): string {
  return computeProgress({
    status,
    totalItems: task.checklistItems.length,
    completedItems: task.checklistItems.filter((item) => item.isCompleted).length,
    currentPercent: percentToWire(task.progressPercent),
  });
}

/** DOCUMENT 13 validation: "`deadline ≥ start_date` when both are supplied". */
function assertDateOrder(startDate: string | null, deadline: string | null): void {
  if (startDate !== null && deadline !== null && deadline < startDate) {
    throw fieldError({ deadline: ['end_before_start'] });
  }
}

function wireDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/**
 * DOCUMENT 13 edge case: a task linked to a goal outside its period is warned
 * about — its deadline falls outside the goal's period, or the goal's period
 * has already closed. Linking is still allowed; the task simply does not
 * count (`GoalLedgerService.qualifyingWhere`).
 */
function goalWarnings(
  goal: LinkableGoal | null,
  deadline: string | null,
): readonly TaskWriteWarning[] {
  if (goal === null) {
    return [];
  }
  const start = wireDate(goal.periodStart) as string;
  const end = wireDate(goal.periodEnd) as string;
  const closed = goal.status === 'achieved' || goal.status === 'missed';
  const outside = deadline !== null && (deadline < start || deadline > end);
  return closed || outside ? ['goal_outside_period'] : [];
}

/** An emptied description is cleared, not stored as an empty string. */
function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === '' ? null : value;
}
