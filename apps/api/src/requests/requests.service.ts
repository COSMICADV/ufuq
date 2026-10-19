/**
 * The Requests Centre — DOCUMENT 08 §4.9, DOCUMENT 01 FR-08, DOCUMENT 04
 * B13 / C8–C10, OD-03 and OD-09 (both approved for Phase 9).
 *
 * The rules that carry the weight:
 *
 *   - **OD-09 hybrid model.** Salary, task and general requests live here
 *     entirely. An attendance row is the inbox entry for a correction, written
 *     by the database from the correction itself; deciding or cancelling it
 *     here **delegates** to `CorrectionsService`, so the correction's window,
 *     recalculation and single transaction are the only ones there are. Leave
 *     rows are indexed the same way from `leave_requests` (Phase 10), and
 *     their decisions delegate to `LeaveRequestsService`.
 *   - **OD-03, option A.** Nobody decides their own request — a manager's goes
 *     to an ADMIN, and an ADMIN's to another ADMIN. Enforced here, in the
 *     shared correction logic, and by `requestReviewableWhere`, not only by
 *     hiding a button.
 *   - **Terminal states are terminal.** Only a pending request is decided or
 *     cancelled; the conditional update means two reviewers racing cannot
 *     both decide it.
 *   - **Approval has no side effect** beyond the request itself for the native
 *     categories (DOCUMENT 01 FR-08 names none), so no salary, task or payroll
 *     record is touched.
 *   - **Scope** (DOCUMENT 02, DOCUMENT 09 §4): another company's request is
 *     404 (row-level security never shows it); an in-tenant request outside
 *     the caller's reach is 403, as for goals and corrections.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AttachmentsService } from '../attachments/attachments.service.js';
import { CORRECTION_INCLUDE, correctionPayload } from '../attendance/attendance-payload.js';
import type { CorrectionPayload } from '../attendance/attendance-payload.js';
import { CorrectionsService } from '../attendance/corrections.service.js';
import { instantAt, parseCalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  conflict,
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { LeaveRequestsService } from '../leave/leave-requests.service.js';
import type { LeaveRequestDetailPayload } from '../leave/leave-payload.js';
import { taskScopeWhere } from '../tasks/task-query.js';

import type {
  ApproveRequestDto,
  CreateRequestDto,
  ListRequestsQueryDto,
  RejectRequestDto,
} from './dto/request.dto.js';
import { RequestEventPublisher } from './request-events.js';
import type { RequestEvent } from './request-events.js';
import { decisionSnapshot, REQUEST_INCLUDE, requestPayload } from './request-payload.js';
import type {
  RequestDetailPayload,
  RequestPayload,
  RequestRow,
  RequestTaskRef,
} from './request-payload.js';
import {
  canReview,
  forbidden,
  requestReviewableWhere,
  requestScopeWhere,
  requestVisibleWhere,
} from './request-query.js';
import { isNativeCategory, SPECIALISED_RELATED_TYPE } from './request-rules.js';

export interface RequestList {
  readonly items: readonly RequestPayload[];
  readonly total: number;
}

export interface PendingCount {
  /** Pending requests the caller can act on. */
  readonly count: number;
  /**
   * `review` — pending requests awaiting the caller's decision (the inbox
   * badge, DOCUMENT 08 §4.9); `own` — the caller's own pending requests
   * (DOCUMENT 04 C1 component 7), for a caller who reviews nothing.
   */
  readonly basis: 'review' | 'own';
}

const ATTENDANCE_TYPE = SPECIALISED_RELATED_TYPE.attendance;
const LEAVE_TYPE = SPECIALISED_RELATED_TYPE.leave;

@Injectable()
export class RequestsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(CorrectionsService) private readonly corrections: CorrectionsService,
    @Inject(RequestEventPublisher) private readonly events: RequestEventPublisher,
    @Inject(LeaveRequestsService) private readonly leave: LeaveRequestsService,
  ) {
    super(prisma, audit);
  }

  // -- Reading -----------------------------------------------------------------

  async list(ctx: AuthContext, query: ListRequestsQueryDto): Promise<RequestList> {
    const page = resolvePage(query);
    const visible = requestVisibleWhere(ctx);

    return this.tenant(ctx, async (tx) => {
      const and: Prisma.RequestWhereInput[] = [visible];
      if (query.category !== undefined) and.push({ category: query.category });
      if (query.status !== undefined) and.push({ status: query.status });
      if (query.employee_id !== undefined) and.push({ employeeId: query.employee_id });
      if (query.reviewable === 'true') and.push(requestReviewableWhere(ctx));
      if (query.from !== undefined || query.to !== undefined) {
        and.push({ createdAt: await this.submittedRange(tx, query.from, query.to) });
      }
      const where: Prisma.RequestWhereInput = { AND: and };

      const [rows, total] = await Promise.all([
        tx.request.findMany({
          where,
          include: REQUEST_INCLUDE,
          // Oldest pending first would hide new work behind old; DOCUMENT 04
          // B13 shows an age indicator instead, so newest first.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.request.count({ where }),
      ]);
      return { items: await this.payloads(tx, ctx, rows), total };
    });
  }

  async findOne(ctx: AuthContext, id: string): Promise<RequestDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await this.requireVisible(tx, ctx, id);
      const [payload] = await this.payloads(tx, ctx, [row]);
      const [files, abilities] = await Promise.all([
        this.attachments.listFor(tx, 'request', id),
        this.attachments.abilitiesFor(tx, ctx, 'request', id),
      ]);
      return {
        ...(payload as RequestPayload),
        attachments: files,
        attachment_abilities: { can_upload: abilities.canUpload, can_delete: abilities.canDelete },
      };
    });
  }

  /** `GET /requests/pending-count` — see {@link PendingCount}. */
  async pendingCount(ctx: AuthContext): Promise<PendingCount> {
    if (canReview(ctx)) {
      const where = requestReviewableWhere(ctx);
      return this.tenant(ctx, async (tx) => ({
        count: await tx.request.count({ where: { AND: [where, { status: 'pending' }] } }),
        basis: 'review' as const,
      }));
    }
    if (ctx.callerEmployeeId === null) {
      throw forbidden();
    }
    const employeeId = ctx.callerEmployeeId;
    return this.tenant(ctx, async (tx) => ({
      count: await tx.request.count({ where: { employeeId, status: 'pending' } }),
      basis: 'own' as const,
    }));
  }

  // -- Submitting --------------------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateRequestDto,
    origin: RequestOrigin,
  ): Promise<RequestDetailPayload> {
    // OD-09: a specialised category is submitted as its own record — an
    // attendance correction through `/attendance-corrections`, which indexes
    // itself here; leave through `/leave-requests` from Phase 10.
    if (!isNativeCategory(dto.category)) {
      throw new AppException(ERROR_CODES.REQUEST_CATEGORY_SPECIALISED, 422, {
        fields: { category: ['specialised'] },
      });
    }
    if (dto.task_id !== undefined && dto.category !== 'task') {
      throw fieldError({ task_id: ['invalid'] });
    }
    // `request.create` is `self` for every role (DOCUMENT 02): a request is
    // always the caller's own.
    requestScopeWhere(ctx, 'request.create');
    const employeeId = ctx.callerEmployeeId;
    if (employeeId === null) {
      throw forbidden();
    }

    const created = await this.tenant(ctx, async (tx) => {
      if (dto.task_id !== undefined) {
        await this.requireTask(tx, ctx, dto.task_id);
      }
      const row = await tx.request.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          employeeId,
          category: dto.category,
          subject: dto.subject,
          description: dto.description,
          relatedType: dto.task_id === undefined ? null : 'task',
          relatedId: dto.task_id ?? null,
          status: 'pending',
          // The application clock, as for goal history (Phase 8): the same
          // clock the date-range filter and the decision times are read by.
          createdAt: new Date(),
        },
        select: { id: true, createdAt: true },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'REQUEST_SUBMITTED',
        entityType: 'request',
        entityId: row.id,
        newValues: {
          category: dto.category,
          subject: dto.subject,
          description: dto.description,
          ...(dto.task_id === undefined ? {} : { task_id: dto.task_id }),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return row;
    });

    await this.publish({
      type: 'request_submitted',
      companyId: ctx.companyId,
      requestId: created.id,
      category: dto.category,
      employeeId,
      decision: null,
      occurredAt: created.createdAt,
    });
    return this.findOne(ctx, created.id);
  }

  // -- Deciding ----------------------------------------------------------------

  async approve(
    ctx: AuthContext,
    id: string,
    dto: ApproveRequestDto,
    origin: RequestOrigin,
  ): Promise<RequestDetailPayload> {
    return this.decide(ctx, id, 'approved', dto.admin_response, origin);
  }

  async reject(
    ctx: AuthContext,
    id: string,
    dto: RejectRequestDto,
    origin: RequestOrigin,
  ): Promise<RequestDetailPayload> {
    return this.decide(ctx, id, 'rejected', dto.admin_response, origin);
  }

  private async decide(
    ctx: AuthContext,
    id: string,
    decision: 'approved' | 'rejected',
    response: string | undefined,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<RequestDetailPayload> {
    const target = await this.tenant(ctx, (tx) => this.requireDecidable(tx, ctx, id));

    if (target.relatedType === ATTENDANCE_TYPE && target.relatedId !== null) {
      // OD-09: the correction's own business logic decides it — its
      // recalculation, its transaction, its audit actions. The inbox row
      // follows by trigger, in that same transaction.
      if (decision === 'approved') {
        await this.corrections.approve(
          ctx,
          target.relatedId,
          response === undefined ? {} : { review_note: response },
          origin,
          now,
        );
      } else {
        await this.corrections.reject(
          ctx,
          target.relatedId,
          { review_note: response ?? '' },
          origin,
          now,
        );
      }
      return this.findOne(ctx, id);
    }

    if (target.relatedType === LEAVE_TYPE && target.relatedId !== null) {
      // OD-09, completed in Phase 10: leave's own service decides it — its
      // balance moves, its attendance days, its single transaction, its
      // `leave.*` audit actions. The inbox row follows by trigger.
      if (decision === 'approved') {
        await this.leave.approve(
          ctx,
          target.relatedId,
          response === undefined ? {} : { review_note: response },
          origin,
          now,
        );
      } else {
        await this.leave.reject(
          ctx,
          target.relatedId,
          { review_note: response ?? '' },
          origin,
          now,
        );
      }
      return this.findOne(ctx, id);
    }

    await this.tenant(ctx, async (tx) => {
      const before = await tx.request.findFirstOrThrow({
        where: { id },
        select: { status: true, reviewedAt: true, adminResponse: true },
      });
      // Conditional on still being pending: of two reviewers deciding at once,
      // exactly one update matches and the other is refused below.
      const { count } = await tx.request.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: decision,
          reviewedBy: ctx.userId,
          reviewedAt: now,
          adminResponse: response ?? null,
        },
      });
      if (count === 0) {
        throw conflict(ERROR_CODES.REQUEST_NOT_PENDING);
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: decision === 'approved' ? 'REQUEST_APPROVED' : 'REQUEST_REJECTED',
        entityType: 'request',
        entityId: id,
        oldValues: decisionSnapshot(before),
        newValues: decisionSnapshot({
          status: decision,
          reviewedAt: now,
          adminResponse: response ?? null,
        }),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });

    await this.publish({
      type: 'request_reviewed',
      companyId: ctx.companyId,
      requestId: id,
      category: target.category,
      employeeId: target.employeeId,
      decision,
      occurredAt: now,
    });
    return this.findOne(ctx, id);
  }

  /** `POST /requests/{id}/cancel` — own, pending only (DOCUMENT 08 §4.9). */
  async cancel(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<RequestDetailPayload> {
    const target = await this.tenant(ctx, async (tx) => {
      const row = await this.requireVisible(tx, ctx, id);
      // "Own", not "in scope": a reviewer withdrawing somebody else's request
      // would be deciding it, and deciding is what approve and reject are for.
      if (row.employeeId !== ctx.callerEmployeeId) {
        throw forbidden();
      }
      if (row.status !== 'pending') {
        throw conflict(ERROR_CODES.REQUEST_NOT_PENDING);
      }
      return row;
    });

    if (target.relatedType === ATTENDANCE_TYPE && target.relatedId !== null) {
      await this.corrections.cancel(ctx, target.relatedId, origin);
      return this.findOne(ctx, id);
    }
    if (target.relatedType === LEAVE_TYPE && target.relatedId !== null) {
      await this.leave.cancel(ctx, target.relatedId, {}, origin);
      return this.findOne(ctx, id);
    }

    await this.tenant(ctx, async (tx) => {
      const { count } = await tx.request.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'cancelled' },
      });
      if (count === 0) {
        throw conflict(ERROR_CODES.REQUEST_NOT_PENDING);
      }
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'REQUEST_CANCELLED',
        entityType: 'request',
        entityId: id,
        oldValues: { status: 'pending' },
        newValues: { status: 'cancelled' },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    // No one is told; the approvers' notifications stop implying it is pending.
    await this.publish({
      type: 'request_cancelled',
      companyId: ctx.companyId,
      requestId: id,
      category: target.category,
      employeeId: target.employeeId,
      decision: null,
      occurredAt: new Date(),
    });
    return this.findOne(ctx, id);
  }

  // -- Internals ---------------------------------------------------------------

  /** 404 for a request this company does not have; 403 for one outside the caller's reach. */
  private async requireVisible(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<RequestRow> {
    const row = await tx.request.findFirst({ where: { id }, include: REQUEST_INCLUDE });
    if (row === null) {
      throw notFound();
    }
    const reachable = await tx.request.findFirst({
      where: { AND: [{ id }, requestVisibleWhere(ctx)] },
      select: { id: true },
    });
    if (reachable === null) {
      throw forbidden();
    }
    return row;
  }

  /**
   * The checks every decision makes, in order: the request exists in this
   * company (404); the caller reviews requests at all and this one is in their
   * scope (403); it is not their own (OD-03 — 403 `REQUEST_SELF_REVIEW`); and
   * it is still pending (409 `REQUEST_NOT_PENDING`).
   */
  private async requireDecidable(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<RequestRow> {
    const row = await tx.request.findFirst({ where: { id }, include: REQUEST_INCLUDE });
    if (row === null) {
      throw notFound();
    }
    const inScope = await tx.request.findFirst({
      where: { AND: [{ id }, requestScopeWhere(ctx, 'request.review')] },
      select: { id: true },
    });
    if (inScope === null) {
      throw forbidden();
    }
    if (row.employeeId === ctx.callerEmployeeId) {
      throw new AppException(ERROR_CODES.REQUEST_SELF_REVIEW, 403);
    }
    if (row.status !== 'pending') {
      throw conflict(ERROR_CODES.REQUEST_NOT_PENDING);
    }
    return row;
  }

  /** A task request names a task the requester can see — normal task scope applies. */
  private async requireTask(tx: TenantClient, ctx: AuthContext, taskId: string): Promise<void> {
    let scope: Prisma.TaskWhereInput;
    try {
      scope = taskScopeWhere(ctx, 'task.view');
    } catch (error) {
      if (error instanceof AppException) {
        throw fieldError({ task_id: ['not_found'] });
      }
      throw error;
    }
    const task = await tx.task.findFirst({
      where: { AND: [{ id: taskId, deletedAt: null }, scope] },
      select: { id: true },
    });
    if (task === null) {
      throw fieldError({ task_id: ['not_found'] });
    }
  }

  /** `from` / `to` are calendar days in the company's timezone, both inclusive. */
  private async submittedRange(
    tx: TenantClient,
    from: string | undefined,
    to: string | undefined,
  ): Promise<Prisma.DateTimeFilter> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    const range: Prisma.DateTimeFilter = {};
    if (from !== undefined) {
      const day = parseCalendarDate(from);
      if (day === null) throw fieldError({ from: ['invalid'] });
      range.gte = instantAt(day, 0, company.timezone);
    }
    if (to !== undefined) {
      const day = parseCalendarDate(to);
      if (day === null) throw fieldError({ to: ['invalid'] });
      range.lt = instantAt(day, 24 * 60, company.timezone);
    }
    return range;
  }

  /**
   * Rows → payloads, with what each category needs beside it: the correction
   * an attendance row indexes, the task a task request names, and what the
   * caller may do. One query per kind for the whole page, never one per row.
   */
  private async payloads(
    tx: TenantClient,
    ctx: AuthContext,
    rows: readonly RequestRow[],
  ): Promise<RequestPayload[]> {
    const ids = rows.map((row) => row.id);
    const correctionIds = rows
      .filter((row) => row.relatedType === ATTENDANCE_TYPE && row.relatedId !== null)
      .map((row) => row.relatedId as string);
    const leaveIds = rows
      .filter((row) => row.relatedType === LEAVE_TYPE && row.relatedId !== null)
      .map((row) => row.relatedId as string);
    const taskIds = rows
      .filter((row) => row.relatedType === 'task' && row.relatedId !== null)
      .map((row) => row.relatedId as string);

    const leaveById: Map<string, LeaveRequestDetailPayload> = await this.leave.contextFor(
      tx,
      ctx,
      leaveIds,
    );
    const [corrections, tasks, reviewable] = await Promise.all([
      correctionIds.length === 0
        ? []
        : tx.attendanceCorrectionRequest.findMany({
            where: { id: { in: correctionIds } },
            include: CORRECTION_INCLUDE,
          }),
      taskIds.length === 0
        ? []
        : tx.task.findMany({
            where: { id: { in: taskIds } },
            select: { id: true, title: true, status: true },
          }),
      canReview(ctx) && ids.length > 0
        ? tx.request.findMany({
            where: { AND: [{ id: { in: ids }, status: 'pending' }, requestReviewableWhere(ctx)] },
            select: { id: true },
          })
        : [],
    ]);

    const correctionById = new Map<string, CorrectionPayload>(
      corrections.map((row) => [row.id, correctionPayload(row)]),
    );
    const taskById = new Map<string, RequestTaskRef>(tasks.map((task) => [task.id, task]));
    const reviewableIds = new Set(reviewable.map((row) => row.id));
    const canCancel = ctx.permissions.has('request.cancel');

    return rows.map((row) => {
      const isOwn = row.employeeId === ctx.callerEmployeeId;
      return requestPayload(row, {
        task: row.relatedType === 'task' ? (taskById.get(row.relatedId ?? '') ?? null) : null,
        attendance:
          row.relatedType === ATTENDANCE_TYPE
            ? (correctionById.get(row.relatedId ?? '') ?? null)
            : null,
        leave: row.relatedType === LEAVE_TYPE ? (leaveById.get(row.relatedId ?? '') ?? null) : null,
        isOwn,
        abilities: {
          can_review: reviewableIds.has(row.id),
          can_cancel: isOwn && canCancel && row.status === 'pending',
        },
      });
    });
  }

  private async publish(event: RequestEvent): Promise<void> {
    await this.events.publish(event);
  }
}
