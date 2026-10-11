/**
 * Leave requests — DOCUMENT 16, DOCUMENT 05 FLOWs 07–08, DOCUMENT 08 §4.6,
 * OD-03, OD-09, OD-11 (approved).
 *
 * The single home of leave's business rules. The Requests Centre delegates
 * approve / reject / cancel of a leave row here (OD-09) and holds none of
 * these rules itself.
 *
 * Guarantees:
 *
 *   - **The server counts the days** (rule 2): the employee's own schedule and
 *     the company's holidays, never a hardcoded weekend; the client never
 *     supplies `days_count`.
 *   - **Holds, transactionally** (rule 3): submission adds the days to each
 *     affected year's `pending_days`; approval moves them to `used_days`;
 *     rejection and cancellation release them. Unpaid types hold and charge
 *     nothing (rule 7).
 *   - **No overcommitment.** Every write that touches an employee's leave
 *     first locks that employee's row (`SELECT … FOR UPDATE`), then the
 *     request, then the balance rows — always in that order. Two submissions,
 *     or two approvers, are therefore serialized: the second sees the first's
 *     holds, or sees the request already decided (409).
 *   - **Approval is one transaction** (rule 4): revalidation, balance, the
 *     `on_leave` attendance days linked back to the request (rule 5), the
 *     request's status and its Requests Centre row (by trigger), all or
 *     nothing.
 *   - **Audit after commit** (DOCUMENT 21 §1–§3): each write collects its
 *     audit entries while the transaction runs and hands them to
 *     `AuditDispatcher` only once it has committed, then publishes the event.
 *     A rollback writes no audit; a failed audit write is retried and never
 *     undoes the committed change.
 *   - **Attendance is never hard-deleted** (DOCUMENT 06 §6, DOCUMENT 12):
 *     cancelling approved leave reconciles its days in place.
 *   - **OD-03**: nobody decides their own leave.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import type { Decimal } from '@ufuq/money';

import { AttachmentsService } from '../attachments/attachments.service.js';
import type { CheckedUpload, UploadedFile } from '../attachments/attachments.service.js';
import { attendanceAuditSnapshot } from '../attendance/attendance-payload.js';
import { dateValue } from '../attendance/attendance-query.js';
import { dayWithoutLeave } from '../attendance/calculation.js';
import {
  dayFor,
  isHolidayOn,
  loadScheduleContext,
  ScheduleIncompleteError,
} from '../attendance/schedule-context.js';
import type { ScheduleContext } from '../attendance/schedule-context.js';
import {
  calendarDateIn,
  compareDates,
  formatCalendarDate,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuditEntry } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { ErrorCode } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type {
  ApproveLeaveDto,
  CalculateLeaveQueryDto,
  CancelLeaveDto,
  CreateLeaveRequestDto,
  ListLeaveRequestsQueryDto,
  RejectLeaveDto,
} from './dto/leave.dto.js';
import { LeaveBalancesService } from './leave-balances.service.js';
import type { LockedBalance } from './leave-balances.service.js';
import { LeaveEventPublisher } from './leave-events.js';
import type { LeaveEvent } from './leave-events.js';
import { LEAVE_PAYROLL_GUARD } from './leave-payroll-guard.js';
import type { LeavePayrollGuard } from './leave-payroll-guard.js';
import { LEAVE_REQUEST_INCLUDE, leaveRequestPayload } from './leave-payload.js';
import type {
  LeaveBalancePayload,
  LeaveRequestDetailPayload,
  LeaveRequestPayload,
  LeaveRequestRow,
} from './leave-payload.js';
import { forbidden, hasCompanyScope, leaveScopeWhere, leaveVisibleWhere } from './leave-query.js';
import {
  allocateByYear,
  allocationFromJson,
  allocationToJson,
  balanceCheck,
  days,
  leaveDates,
  remaining,
  sameAllocation,
  totalDays,
} from './leave-rules.js';

/** The employee fields every leave write reads, under the employee row lock. */
interface Subject {
  readonly id: string;
  readonly joiningDate: Date;
  readonly terminationDate: Date | null;
  readonly workScheduleId: string;
}

interface TypeRow {
  readonly id: string;
  readonly isPaid: boolean;
  readonly allowsNegativeBalance: boolean;
  readonly requiresAttachment: boolean;
  readonly defaultDaysPerYear: { toString(): string };
}

interface Assessment {
  readonly context: ScheduleContext;
  readonly dates: readonly CalendarDate[];
  readonly allocation: Map<number, Decimal>;
  readonly total: Decimal;
}

export interface YearImpact {
  readonly year: number;
  readonly days: string;
  readonly remaining_before: string;
  readonly remaining_after: string;
}

/** `GET /leave-requests/calculate` — the live day count and its balance impact. */
export interface LeaveCalculation {
  readonly days_count: string;
  readonly year_allocation: Record<string, string>;
  readonly dates: readonly string[];
  readonly leave_type: {
    readonly id: string;
    readonly is_paid: boolean;
    readonly allows_negative_balance: boolean;
    readonly requires_attachment: boolean;
  } | null;
  /** Per affected year, for a paid type. Empty for an unpaid type (rule 7). */
  readonly balance_impact: readonly YearImpact[];
  /** Days beyond the balance (rule 6). Non-zero only where the type allows a negative balance. */
  readonly excess_days: string;
  /** False when the balance does not cover the request and the type does not allow negative. */
  readonly sufficient: boolean;
}

export interface LeaveWriteResult extends LeaveRequestDetailPayload {
  /** `exceeds_balance` — submitted beyond the balance, where the type allows it (rule 6). */
  readonly warnings: readonly string[];
  readonly excess_days: string;
}

const OPEN: ('pending' | 'approved')[] = ['pending', 'approved'];

@Injectable()
export class LeaveRequestsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(LeaveBalancesService) private readonly balances: LeaveBalancesService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(LeaveEventPublisher) private readonly events: LeaveEventPublisher,
    @Inject(LEAVE_PAYROLL_GUARD) private readonly payroll: LeavePayrollGuard,
  ) {
    super(prisma);
  }

  // -- GET /leave-requests/calculate -------------------------------------------

  async calculate(ctx: AuthContext, query: CalculateLeaveQueryDto): Promise<LeaveCalculation> {
    const employeeId = this.requester(ctx);
    return this.tenant(ctx, async (tx) => {
      const employee = await this.subject(tx, employeeId);
      const type =
        query.leave_type_id === undefined ? null : await this.activeType(tx, query.leave_type_id);
      const assessed = await this.assess(tx, employee, query.start_date, query.end_date);
      const impact: YearImpact[] = [];
      let excess = days('0');
      let sufficient = true;
      if (type !== null && type.isPaid) {
        for (const [year, amount] of assessed.allocation) {
          await this.balances.ensure(tx, ctx.companyId, employee, type, year);
          const row = await tx.leaveBalance.findUniqueOrThrow({
            where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type.id, year } },
          });
          const before = remaining({
            totalDays: days(row.totalDays),
            usedDays: days(row.usedDays),
            pendingDays: days(row.pendingDays),
            carriedOverDays: days(row.carriedOverDays),
          });
          const check = balanceCheck(before, amount, type.allowsNegativeBalance);
          excess = excess.add(check.excess);
          if (!check.ok) sufficient = false;
          impact.push({
            year,
            days: amount.toString(),
            remaining_before: before.toString(),
            remaining_after: before.subtract(amount).toString(),
          });
        }
      }
      return {
        days_count: assessed.total.toString(),
        year_allocation: allocationToJson(assessed.allocation),
        dates: assessed.dates.map(formatCalendarDate),
        leave_type:
          type === null
            ? null
            : {
                id: type.id,
                is_paid: type.isPaid,
                allows_negative_balance: type.allowsNegativeBalance,
                requires_attachment: type.requiresAttachment,
              },
        balance_impact: impact,
        excess_days: sufficient ? excess.toString() : '0.00',
        sufficient,
      };
    });
  }

  // -- POST /leave-requests ----------------------------------------------------

  async create(
    ctx: AuthContext,
    dto: CreateLeaveRequestDto,
    file: UploadedFile | undefined,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<LeaveWriteResult> {
    const employeeId = this.requester(ctx);
    // DOCUMENT 20 §7 checks and the upload allowance happen before the
    // transaction; the file itself is stored inside it, with the request.
    const checked: CheckedUpload | null =
      file === undefined ? null : await this.attachments.prepareUpload(ctx, file);

    const audits: AuditEntry[] = [];
    const { id, warnings, excess } = await this.tenant(ctx, async (tx) => {
      const employee = await this.lockEmployee(tx, employeeId);
      const type = await this.activeType(tx, dto.leave_type_id);
      // Rule 9: enforced here, at field level (DOCUMENT 16 "Error states").
      if (type.requiresAttachment && checked === null) {
        throw fieldError({ file: ['required'] });
      }
      const assessed = await this.assess(tx, employee, dto.start_date, dto.end_date);
      const range = this.range(dto.start_date, dto.end_date);
      await this.assertNoOverlap(tx, employeeId, range.from, range.to, null);
      await this.assertNoCheckIn(tx, employeeId, assessed.dates);
      await this.payroll.assertPeriodsOpen(tx, employeeId, assessed.dates);

      const notes: string[] = [];
      let excessDays = days('0');
      const locked: [LockedBalance, Decimal][] = [];
      if (type.isPaid) {
        for (const [year, amount] of assessed.allocation) {
          const balance = await this.balances.lock(tx, ctx.companyId, employee, type, year);
          const check = balanceCheck(remaining(balance), amount, type.allowsNegativeBalance);
          if (!check.ok) {
            throw new AppException(ERROR_CODES.LEAVE_INSUFFICIENT_BALANCE, 422, {
              fields: {
                days_count: ['insufficient_balance'],
                remaining: [remaining(balance).toString()],
                requested: [amount.toString()],
                year: [String(year)],
              },
            });
          }
          excessDays = excessDays.add(check.excess);
          locked.push([balance, amount]);
        }
        if (!excessDays.isZero()) notes.push('exceeds_balance');
      }

      const leaveId = generateId();
      await tx.leaveRequest.create({
        data: {
          id: leaveId,
          companyId: ctx.companyId,
          employeeId,
          leaveTypeId: type.id,
          startDate: dateValue(range.from),
          endDate: dateValue(range.to),
          daysCount: assessed.total.toString(),
          yearAllocation: allocationToJson(assessed.allocation),
          reason: dto.reason,
          status: 'pending',
          createdAt: now,
        },
      });
      for (const [balance, amount] of locked) {
        await this.balances.move(tx, balance, { pending: amount });
      }
      let attachmentId: string | null = null;
      if (checked !== null) {
        const stored = await this.attachments.storeChecked(
          tx,
          ctx,
          checked,
          'leave_request',
          leaveId,
          origin,
          audits,
        );
        attachmentId = stored.id;
        await tx.leaveRequest.update({ where: { id: leaveId }, data: { attachmentId } });
      }
      audits.push({
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'LEAVE_REQUESTED',
        entityType: 'leave_request',
        entityId: leaveId,
        newValues: {
          leave_type_id: type.id,
          start_date: dto.start_date,
          end_date: dto.end_date,
          days_count: assessed.total.toString(),
          year_allocation: allocationToJson(assessed.allocation),
          reason: dto.reason,
          attachment_id: attachmentId,
          ...(excessDays.isZero() ? {} : { excess_days: excessDays.toString() }),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return { id: leaveId, warnings: notes, excess: excessDays };
    });

    await this.audit.dispatch(audits);
    await this.publish('leave_request_submitted', ctx.companyId, id, employeeId, now);
    return { ...(await this.findOne(ctx, id)), warnings, excess_days: excess.toString() };
  }

  // -- Reading -----------------------------------------------------------------

  async list(
    ctx: AuthContext,
    query: ListLeaveRequestsQueryDto,
  ): Promise<{ readonly items: readonly LeaveRequestPayload[]; readonly total: number }> {
    const page = resolvePage(query);
    const visible = leaveVisibleWhere(ctx) as Prisma.LeaveRequestWhereInput;
    const and: Prisma.LeaveRequestWhereInput[] = [visible];
    if (query.status !== undefined) and.push({ status: query.status });
    if (query.leave_type_id !== undefined) and.push({ leaveTypeId: query.leave_type_id });
    if (query.employee_id !== undefined) and.push({ employeeId: query.employee_id });
    if (query.from !== undefined)
      and.push({ endDate: { gte: dateValue(this.date(query.from, 'from')) } });
    if (query.to !== undefined)
      and.push({ startDate: { lte: dateValue(this.date(query.to, 'to')) } });
    const where: Prisma.LeaveRequestWhereInput = { AND: and };
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.leaveRequest.findMany({
          where,
          include: LEAVE_REQUEST_INCLUDE,
          orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.leaveRequest.count({ where }),
      ]);
      return { items: await this.payloads(tx, ctx, rows), total };
    });
  }

  async findOne(ctx: AuthContext, id: string): Promise<LeaveRequestDetailPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.leaveRequest.findFirst({
        where: { id },
        include: LEAVE_REQUEST_INCLUDE,
      });
      if (row === null) {
        throw notFound();
      }
      const reachable = await tx.leaveRequest.findFirst({
        where: { AND: [{ id }, leaveVisibleWhere(ctx) as Prisma.LeaveRequestWhereInput] },
        select: { id: true },
      });
      if (reachable === null) {
        throw forbidden();
      }
      const [details] = await this.details(tx, ctx, [row]);
      return details as LeaveRequestDetailPayload;
    });
  }

  /**
   * The Requests Centre's view of leave rows (OD-09): the same payload the
   * leave endpoints return, for the requests on one page. Visibility has
   * already been decided by the centre's own scope.
   */
  async contextFor(
    tx: TenantClient,
    ctx: AuthContext,
    ids: readonly string[],
  ): Promise<Map<string, LeaveRequestDetailPayload>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.leaveRequest.findMany({
      where: { id: { in: [...ids] } },
      include: LEAVE_REQUEST_INCLUDE,
    });
    const details = await this.details(tx, ctx, rows);
    return new Map(details.map((detail) => [detail.id, detail]));
  }

  // -- Decisions ---------------------------------------------------------------

  /** POST /leave-requests/{id}/approve — DOCUMENT 16 rule 4, FLOW 08. */
  async approve(
    ctx: AuthContext,
    id: string,
    dto: ApproveLeaveDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<LeaveRequestDetailPayload> {
    const audits: AuditEntry[] = [];
    const employeeId = await this.tenant(ctx, async (tx) => {
      const row = await this.lockForDecision(tx, ctx, id);
      const employee = await this.subject(tx, row.employeeId);
      const type = row.leaveType;

      // Revalidate everything submission checked: the days still count the
      // same way, nothing approved overlaps, nobody checked in on them, and
      // the payroll period is still open.
      const range = {
        from: calendarDateIn(row.startDate, 'UTC'),
        to: calendarDateIn(row.endDate, 'UTC'),
      };
      const assessed = await this.assess(
        tx,
        employee,
        formatCalendarDate(range.from),
        formatCalendarDate(range.to),
      );
      if (!sameAllocation(assessed.allocation, allocationFromJson(row.yearAllocation))) {
        throw this.conflict(ERROR_CODES.LEAVE_RANGE_CHANGED);
      }
      await this.assertNoOverlap(tx, row.employeeId, range.from, range.to, id);
      await this.assertNoCheckIn(tx, row.employeeId, assessed.dates);
      await this.payroll.assertPeriodsOpen(tx, row.employeeId, assessed.dates);

      // Rule 3: the hold becomes use.
      if (type.isPaid) {
        for (const [year, amount] of assessed.allocation) {
          const balance = await this.balances.lock(tx, ctx.companyId, employee, type, year);
          await this.balances.move(tx, balance, { pending: amount.negate(), used: amount });
        }
      }

      // Rule 5 / DOCUMENT 12 rule 8: one `on_leave` day per leave day, linked
      // back. A day already recorded without a check-in (an absence the
      // nightly job wrote, say) becomes the leave day, audited (DOCUMENT 12
      // "Leave approved for past dates").
      const existing = await tx.attendanceRecord.findMany({
        where: { employeeId: row.employeeId, date: { in: assessed.dates.map(dateValue) } },
      });
      const byDate = new Map(
        existing.map((record) => [record.date.toISOString().slice(0, 10), record]),
      );
      for (const date of assessed.dates) {
        const record = byDate.get(formatCalendarDate(date));
        const leaveDay = {
          status: 'on_leave' as const,
          source: 'system' as const,
          leaveRequestId: id,
          workMode: null,
          checkInAt: null,
          checkOutAt: null,
          workingMinutes: null,
          overtimeMinutes: null,
          lateMinutes: null,
        };
        if (record === undefined) {
          await tx.attendanceRecord.create({
            data: {
              id: generateId(),
              companyId: ctx.companyId,
              employeeId: row.employeeId,
              date: dateValue(date),
              ...leaveDay,
            },
          });
        } else {
          const updated = await tx.attendanceRecord.update({
            where: { id: record.id },
            data: leaveDay,
          });
          audits.push({
            companyId: ctx.companyId,
            userId: ctx.userId,
            action: 'ATTENDANCE_ADJUSTED_BY_ADMIN',
            entityType: 'attendance_record',
            entityId: record.id,
            oldValues: attendanceAuditSnapshot(record),
            newValues: { ...attendanceAuditSnapshot(updated), leave_request_id: id },
            ipAddress: origin.ipAddress,
            userAgent: origin.userAgent,
          });
        }
      }

      await tx.leaveRequest.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedBy: ctx.userId,
          reviewedAt: now,
          reviewNote: dto.review_note ?? null,
        },
      });
      audits.push({
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'LEAVE_APPROVED',
        entityType: 'leave_request',
        entityId: id,
        oldValues: { status: 'pending' },
        newValues: {
          status: 'approved',
          days_count: assessed.total.toString(),
          dates: assessed.dates.map(formatCalendarDate),
          ...(dto.review_note === undefined ? {} : { review_note: dto.review_note }),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return row.employeeId;
    });

    await this.audit.dispatch(audits);
    await this.publish('leave_approved', ctx.companyId, id, employeeId, now);
    return this.findOne(ctx, id);
  }

  /** POST /leave-requests/{id}/reject — rule 8: a reason; rule 3: the hold is released. */
  async reject(
    ctx: AuthContext,
    id: string,
    dto: RejectLeaveDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<LeaveRequestDetailPayload> {
    const audits: AuditEntry[] = [];
    const employeeId = await this.tenant(ctx, async (tx) => {
      const row = await this.lockForDecision(tx, ctx, id);
      await this.releaseHolds(tx, ctx, row);
      await tx.leaveRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewedBy: ctx.userId,
          reviewedAt: now,
          reviewNote: dto.review_note,
        },
      });
      audits.push({
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'LEAVE_REJECTED',
        entityType: 'leave_request',
        entityId: id,
        oldValues: { status: 'pending' },
        newValues: { status: 'rejected', review_note: dto.review_note },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return row.employeeId;
    });
    await this.audit.dispatch(audits);
    await this.publish('leave_rejected', ctx.companyId, id, employeeId, now);
    return this.findOne(ctx, id);
  }

  /**
   * POST /leave-requests/{id}/cancel — two documented actions on one endpoint
   * (DOCUMENT 08 §4.6 as amended in Phase 10):
   *
   *   - **The requester withdraws their own pending request** (rule 15): the
   *     hold is released. An employee never cancels approved leave.
   *   - **An ADMIN cancels approved leave** (rule 15): `leave.approve` at
   *     company scope, never their own (OD-03), with a reason. The used days
   *     go back to the balance, and every attendance day the leave wrote is
   *     reconciled in place to its non-leave state (`dayWithoutLeave`).
   *     Attendance records are never hard-deleted.
   */
  async cancel(
    ctx: AuthContext,
    id: string,
    dto: CancelLeaveDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<LeaveRequestDetailPayload> {
    const audits: AuditEntry[] = [];
    const employeeId = await this.tenant(ctx, async (tx) => {
      const found = await tx.leaveRequest.findFirst({
        where: { id },
        select: { employeeId: true },
      });
      if (found === null) {
        throw notFound();
      }
      const visible = await tx.leaveRequest.findFirst({
        where: { AND: [{ id }, leaveVisibleWhere(ctx) as Prisma.LeaveRequestWhereInput] },
        select: { id: true },
      });
      if (visible === null) {
        throw forbidden();
      }

      if (found.employeeId === ctx.callerEmployeeId) {
        if (!ctx.permissions.has('leave.request')) throw forbidden();
        await this.lockEmployee(tx, found.employeeId);
        const row = await this.lockRequest(tx, id);
        if (row.status !== 'pending') {
          // Own approved leave is never self-cancelled (rule 15, OD-03).
          throw this.conflict(ERROR_CODES.LEAVE_NOT_PENDING);
        }
        await this.releaseHolds(tx, ctx, row);
        await tx.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
        audits.push({
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'LEAVE_CANCELLED',
          entityType: 'leave_request',
          entityId: id,
          oldValues: { status: 'pending' },
          newValues: {
            status: 'cancelled',
            ...(dto.reason === undefined ? {} : { reason: dto.reason }),
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return found.employeeId;
      }

      // Somebody else's leave: only an ADMIN, only approved leave.
      if (!hasCompanyScope(ctx, 'leave.approve')) {
        throw forbidden();
      }
      await this.lockEmployee(tx, found.employeeId);
      const row = await this.lockRequest(tx, id);
      if (row.status === 'pending') {
        // Deciding a pending request is approve / reject, not cancel.
        throw forbidden();
      }
      if (row.status !== 'approved') {
        throw this.conflict(ERROR_CODES.LEAVE_NOT_PENDING);
      }
      if (dto.reason === undefined) {
        throw fieldError({ reason: ['required'] });
      }
      await this.reverseApproved(tx, ctx, row, dto.reason, origin, now, audits);
      await tx.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
      return found.employeeId;
    });

    await this.audit.dispatch(audits);
    await this.publish('leave_cancelled', ctx.companyId, id, employeeId, now);
    return this.findOne(ctx, id);
  }

  // -- Internals ---------------------------------------------------------------

  /** `leave.request` is `self` for every role (DOCUMENT 02): leave is always the caller's own. */
  private requester(ctx: AuthContext): string {
    leaveScopeWhere(ctx, 'leave.request');
    if (ctx.callerEmployeeId === null) {
      throw forbidden();
    }
    return ctx.callerEmployeeId;
  }

  private async subject(tx: TenantClient, employeeId: string): Promise<Subject> {
    return tx.employee.findFirstOrThrow({
      where: { id: employeeId },
      select: { id: true, joiningDate: true, terminationDate: true, workScheduleId: true },
    });
  }

  /** The serialization point for one employee's leave (see the file header). */
  private async lockEmployee(tx: TenantClient, employeeId: string): Promise<Subject> {
    await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE`;
    return this.subject(tx, employeeId);
  }

  private async lockRequest(tx: TenantClient, id: string): Promise<LeaveRequestRow> {
    await tx.$queryRaw`SELECT id FROM leave_requests WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.leaveRequest.findUniqueOrThrow({ where: { id }, include: LEAVE_REQUEST_INCLUDE });
  }

  private async activeType(tx: TenantClient, id: string): Promise<TypeRow> {
    const type = await tx.leaveType.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        isPaid: true,
        allowsNegativeBalance: true,
        requiresAttachment: true,
        defaultDaysPerYear: true,
      },
    });
    if (type === null) {
      throw fieldError({ leave_type_id: ['not_found'] });
    }
    return type;
  }

  /**
   * The checks every decision makes, in order: the request exists in this
   * company (404); it is not the caller's own (OD-03 — 403
   * `REQUEST_SELF_REVIEW`); the caller's `leave.approve` scope reaches it
   * (403); then, holding the employee and request locks, it is still pending
   * (409). Two approvers racing are serialized by the locks; the second gets
   * 409.
   */
  private async lockForDecision(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<LeaveRequestRow & { leaveType: TypeRow }> {
    const found = await tx.leaveRequest.findFirst({ where: { id }, select: { employeeId: true } });
    if (found === null) {
      throw notFound();
    }
    // Own leave first: it is never the caller's to decide (OD-03), whatever
    // their scope — and a manager's `team` scope does not even include it.
    if (found.employeeId === ctx.callerEmployeeId) {
      throw new AppException(ERROR_CODES.REQUEST_SELF_REVIEW, 403);
    }
    const inScope = await tx.leaveRequest.findFirst({
      where: {
        AND: [{ id }, leaveScopeWhere(ctx, 'leave.approve') as Prisma.LeaveRequestWhereInput],
      },
      select: { id: true },
    });
    if (inScope === null) {
      throw forbidden();
    }
    await this.lockEmployee(tx, found.employeeId);
    const row = await this.lockRequest(tx, id);
    if (row.status !== 'pending') {
      throw this.conflict(ERROR_CODES.LEAVE_NOT_PENDING);
    }
    const type = await tx.leaveType.findUniqueOrThrow({
      where: { id: row.leaveTypeId },
      select: {
        id: true,
        isPaid: true,
        allowsNegativeBalance: true,
        requiresAttachment: true,
        defaultDaysPerYear: true,
      },
    });
    return { ...row, leaveType: { ...row.leaveType, ...type } };
  }

  /** Rule 3: release exactly the days the request holds, year by year. */
  private async releaseHolds(
    tx: TenantClient,
    ctx: AuthContext,
    row: LeaveRequestRow,
  ): Promise<void> {
    if (!row.leaveType.isPaid) return;
    const employee = await this.subject(tx, row.employeeId);
    const type = await tx.leaveType.findUniqueOrThrow({
      where: { id: row.leaveTypeId },
      select: { id: true, defaultDaysPerYear: true },
    });
    for (const [year, amount] of allocationFromJson(row.yearAllocation)) {
      const balance = await this.balances.lock(tx, ctx.companyId, employee, type, year);
      await this.balances.move(tx, balance, { pending: amount.negate() });
    }
  }

  /** Rule 15 — undo an approval: balance back, attendance days reconciled in place, audited after commit. */
  private async reverseApproved(
    tx: TenantClient,
    ctx: AuthContext,
    row: LeaveRequestRow,
    reason: string,
    origin: RequestOrigin,
    now: Date,
    audits: AuditEntry[],
  ): Promise<void> {
    const records = await tx.attendanceRecord.findMany({
      where: { leaveRequestId: row.id },
      orderBy: { date: 'asc' },
    });
    const dates = records.map((record) => calendarDateIn(record.date, 'UTC'));
    await this.payroll.assertPeriodsOpen(tx, row.employeeId, dates);

    const employee = await this.subject(tx, row.employeeId);
    if (row.leaveType.isPaid) {
      const type = await tx.leaveType.findUniqueOrThrow({
        where: { id: row.leaveTypeId },
        select: { id: true, defaultDaysPerYear: true },
      });
      for (const [year, amount] of allocationFromJson(row.yearAllocation)) {
        const balance = await this.balances.lock(tx, ctx.companyId, employee, type, year);
        await this.balances.move(tx, balance, { used: amount.negate() });
      }
    }

    // Reconcile every day the leave wrote, in place: never deleted
    // (DOCUMENT 06 §6, DOCUMENT 12; the app role has no DELETE on
    // attendance_records). See `dayWithoutLeave` for the state each gets.
    const today = await this.balances.today(tx, now);
    const reconciled: Record<string, string> = {};
    if (records.length > 0) {
      const first = dates[0] as CalendarDate;
      const last = dates[dates.length - 1] as CalendarDate;
      const context = await loadScheduleContext(tx, employee.workScheduleId, first, last);
      for (const [index, record] of records.entries()) {
        const date = dates[index] as CalendarDate;
        const evaluated = dayWithoutLeave({
          date,
          schedule: context.settings,
          day: dayFor(context, date, employee.workScheduleId),
          checkInAt: record.checkInAt,
          checkOutAt: record.checkOutAt,
          isHoliday: isHolidayOn(context, date),
          beforeToday: compareDates(date, today) < 0,
        });
        const updated = await tx.attendanceRecord.update({
          where: { id: record.id },
          data: {
            status: evaluated.status as never,
            workingMinutes: evaluated.workingMinutes,
            overtimeMinutes: evaluated.overtimeMinutes,
            lateMinutes: evaluated.lateMinutes,
            leaveRequestId: null,
          },
        });
        audits.push({
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'ATTENDANCE_ADJUSTED_BY_ADMIN',
          entityType: 'attendance_record',
          entityId: record.id,
          oldValues: { ...attendanceAuditSnapshot(record), leave_request_id: row.id },
          newValues: { ...attendanceAuditSnapshot(updated), leave_request_id: null },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        reconciled[formatCalendarDate(date)] = evaluated.status;
      }
    }

    audits.push({
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'LEAVE_CANCELLED',
      entityType: 'leave_request',
      entityId: row.id,
      oldValues: { status: 'approved' },
      newValues: { status: 'cancelled', reason, reconciled_days: reconciled },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }

  /**
   * The leave days of a range for an employee, with every DOCUMENT 16
   * validation that depends only on the range: ordered dates, not before the
   * joining date, not after a termination, and at least one working day.
   */
  private async assess(
    tx: TenantClient,
    employee: Subject,
    start: string,
    end: string,
  ): Promise<Assessment> {
    const { from, to } = this.range(start, end);
    const joining = calendarDateIn(employee.joiningDate, 'UTC');
    if (compareDates(from, joining) < 0) {
      throw fieldError({ start_date: ['before_joining'] });
    }
    if (
      employee.terminationDate !== null &&
      compareDates(to, calendarDateIn(employee.terminationDate, 'UTC')) > 0
    ) {
      throw fieldError({ end_date: ['after_termination'] });
    }
    let context: ScheduleContext;
    let dates: CalendarDate[];
    try {
      context = await loadScheduleContext(tx, employee.workScheduleId, from, to);
      dates = leaveDates(context, employee.workScheduleId, from, to);
    } catch (error) {
      if (error instanceof ScheduleIncompleteError) {
        throw fieldError({ start_date: ['schedule_incomplete'] });
      }
      throw error;
    }
    if (dates.length === 0) {
      throw new AppException(ERROR_CODES.LEAVE_NO_WORKING_DAYS, 422, {
        fields: { start_date: ['no_working_days'] },
      });
    }
    const allocation = allocateByYear(dates);
    return { context, dates, allocation, total: totalDays(allocation) };
  }

  private range(start: string, end: string): { from: CalendarDate; to: CalendarDate } {
    const from = this.date(start, 'start_date');
    const to = this.date(end, 'end_date');
    if (compareDates(to, from) < 0) {
      throw fieldError({ end_date: ['end_before_start'] });
    }
    return { from, to };
  }

  private date(value: string, field: string): CalendarDate {
    const parsed = parseCalendarDate(value);
    if (parsed === null) {
      throw fieldError({ [field]: ['invalid'] });
    }
    return parsed;
  }

  /** Rule 10 — overlapping leave (pending or approved) is blocked, naming it. */
  private async assertNoOverlap(
    tx: TenantClient,
    employeeId: string,
    from: CalendarDate,
    to: CalendarDate,
    except: string | null,
  ): Promise<void> {
    const overlapping = await tx.leaveRequest.findMany({
      where: {
        employeeId,
        status: { in: OPEN },
        startDate: { lte: dateValue(to) },
        endDate: { gte: dateValue(from) },
        ...(except === null ? {} : { id: { not: except } }),
      },
      select: { id: true, startDate: true, endDate: true },
    });
    if (overlapping.length > 0) {
      throw new AppException(ERROR_CODES.LEAVE_OVERLAP, 409, {
        fields: {
          conflicting_requests: overlapping.map((row) => row.id),
          conflicting_dates: overlapping.map(
            (row) =>
              `${row.startDate.toISOString().slice(0, 10)}/${row.endDate.toISOString().slice(0, 10)}`,
          ),
        },
      });
    }
  }

  /** Rule 11 — a day with a check-in was evidently worked; blocked, naming the day. */
  private async assertNoCheckIn(
    tx: TenantClient,
    employeeId: string,
    dates: readonly CalendarDate[],
  ): Promise<void> {
    const worked = await tx.attendanceRecord.findMany({
      where: { employeeId, date: { in: dates.map(dateValue) }, checkInAt: { not: null } },
      select: { date: true, checkInAt: true },
      orderBy: { date: 'asc' },
    });
    if (worked.length > 0) {
      throw new AppException(ERROR_CODES.LEAVE_ATTENDANCE_CONFLICT, 409, {
        fields: {
          conflicting_dates: worked.map((row) => row.date.toISOString().slice(0, 10)),
          check_in_at: worked.map((row) => row.checkInAt?.toISOString() ?? ''),
        },
      });
    }
  }

  private conflict(code: ErrorCode): AppException {
    return new AppException(code, 409);
  }

  private async payloads(
    tx: TenantClient,
    ctx: AuthContext,
    rows: readonly LeaveRequestRow[],
  ): Promise<LeaveRequestPayload[]> {
    const reviewable = await this.reviewableIds(tx, ctx, rows);
    const canCancelApproved = hasCompanyScope(ctx, 'leave.approve');
    return rows.map((row) => {
      const isOwn = row.employeeId === ctx.callerEmployeeId;
      return leaveRequestPayload(row, {
        isOwn,
        abilities: {
          can_review: reviewable.has(row.id),
          can_cancel: isOwn && row.status === 'pending' && ctx.permissions.has('leave.request'),
          can_cancel_approved: !isOwn && row.status === 'approved' && canCancelApproved,
        },
      });
    });
  }

  private async details(
    tx: TenantClient,
    ctx: AuthContext,
    rows: readonly LeaveRequestRow[],
  ): Promise<LeaveRequestDetailPayload[]> {
    const payloads = await this.payloads(tx, ctx, rows);
    const result: LeaveRequestDetailPayload[] = [];
    for (const [index, payload] of payloads.entries()) {
      const row = rows[index] as LeaveRequestRow;
      const years = [...allocationFromJson(row.yearAllocation).keys()];
      const balances: readonly LeaveBalancePayload[] = row.leaveType.isPaid
        ? await this.balances.forRequest(tx, row.employeeId, row.leaveTypeId, years)
        : [];
      let holidaysInside: string[] = [];
      if (row.status === 'approved') {
        const leaveDays = await tx.attendanceRecord.findMany({
          where: { leaveRequestId: row.id },
          select: { date: true },
        });
        if (leaveDays.length > 0) {
          const holidays = await tx.holiday.findMany({
            where: { date: { in: leaveDays.map((day) => day.date) } },
            select: { date: true },
            orderBy: { date: 'asc' },
          });
          holidaysInside = holidays.map((holiday) => holiday.date.toISOString().slice(0, 10));
        }
      }
      result.push({ ...payload, balances, holidays_inside: holidaysInside });
    }
    return result;
  }

  private async reviewableIds(
    tx: TenantClient,
    ctx: AuthContext,
    rows: readonly LeaveRequestRow[],
  ): Promise<Set<string>> {
    const pending = rows.filter(
      (row) => row.status === 'pending' && row.employeeId !== ctx.callerEmployeeId,
    );
    if (pending.length === 0 || !ctx.permissions.has('leave.approve')) return new Set();
    let scope;
    try {
      scope = leaveScopeWhere(ctx, 'leave.approve');
    } catch (error) {
      if (error instanceof AppException) return new Set();
      throw error;
    }
    const reachable = await tx.leaveRequest.findMany({
      where: {
        AND: [{ id: { in: pending.map((row) => row.id) } }, scope as Prisma.LeaveRequestWhereInput],
      },
      select: { id: true },
    });
    return new Set(reachable.map((row) => row.id));
  }

  private async publish(
    type: LeaveEvent['type'],
    companyId: string,
    leaveRequestId: string,
    employeeId: string,
    occurredAt: Date,
  ): Promise<void> {
    await this.events.publish({ type, companyId, leaveRequestId, employeeId, occurredAt });
  }
}
