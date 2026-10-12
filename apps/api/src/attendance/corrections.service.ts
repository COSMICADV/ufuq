/**
 * Attendance corrections — DOCUMENT 08 §4.5, DOCUMENT 12, DOCUMENT 04 B7/C4.
 *
 * The rules that carry the weight:
 *
 *   - **The window** (DOCUMENT 12 rule 13): a correction may only be raised for
 *     a date in the past and within the window *this company* has configured —
 *     `companies.correction_window_days`, read per request, defaulting to
 *     DOCUMENT 12's seven days. An administrator changes it on the company
 *     settings screen.
 *   - **Approval writes both the attendance change and the audit record**
 *     (DOCUMENT 04 B7), in one transaction: a decision that is recorded but
 *     not applied, or applied but not recorded, is worse than either.
 *   - **Rejection requires a reason** (DOCUMENT 12 validation), enforced by the
 *     DTO and by the table's own CHECK.
 *   - **An employee may cancel only their own, only while pending**
 *     (DOCUMENT 12 ACTIONS).
 *   - **Nobody decides their own correction** (OD-03, option A, approved for
 *     Phase 9): a manager's goes to an ADMIN, an ADMIN's to another ADMIN.
 *     Checked here, so both `/attendance-corrections` and the Requests Centre
 *     (which delegates to this service) refuse it.
 *   - The applied record is recalculated from the schedule in effect on that
 *     date, never copied from the request: an approver approves *times*, and
 *     what those times mean is the schedule's business, not the requester's.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type {
  CorrectionStatus as CorrectionStatusValue,
  Prisma,
  PrismaClient,
  TenantClient,
} from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { PayrollPeriodGuard } from '../payroll/payroll-period-guard.js';
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

import { calculateDay } from './calculation.js';
import {
  CORRECTION_INCLUDE,
  attendanceAuditSnapshot,
  correctionPayload,
} from './attendance-payload.js';
import type { CorrectionPayload } from './attendance-payload.js';
import { correctionScopeWhere, dateValue, forbidden } from './attendance-query.js';
import { dayFor, isHolidayOn, loadScheduleContext } from './schedule-context.js';
import type {
  ApproveCorrectionDto,
  CorrectionListQueryDto,
  CreateCorrectionDto,
  RejectCorrectionDto,
} from './dto/attendance.dto.js';
import { calendarDateIn, compareDates, daysBetween, parseCalendarDate } from './zoned-time.js';
import type { CalendarDate } from './zoned-time.js';

/**
 * DOCUMENT 12 rule 13 — "corrections have a window, default 7 days,
 * configurable per company".
 *
 * The window is `companies.correction_window_days`, read per request from the
 * caller's own company. This constant is the column's default and exists only
 * so the schema's default and the documentation agree in one place; nothing in
 * this service uses it to decide anything.
 */
export const DEFAULT_CORRECTION_WINDOW_DAYS = 7;

export interface CorrectionList {
  readonly items: readonly CorrectionPayload[];
  readonly total: number;
}

@Injectable()
export class CorrectionsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(PayrollPeriodGuard) private readonly periods: PayrollPeriodGuard,
  ) {
    super(prisma, audit);
  }

  async create(
    ctx: AuthContext,
    dto: CreateCorrectionDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<CorrectionPayload> {
    const date = requireDate(dto.date);

    return this.tenant(ctx, async (tx) => {
      const employeeId = await this.resolveSubject(tx, ctx, dto.employee_id);

      const employee = await tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true, workScheduleId: true },
      });
      if (employee === null) {
        throw fieldError({ employee_id: ['not_found'] });
      }

      const company = await tx.company.findFirstOrThrow({
        select: { timezone: true, correctionWindowDays: true },
      });
      const today = calendarDateIn(now, company.timezone);

      // DOCUMENT 12 / DOCUMENT 04 C4: the date must be in the past …
      if (compareDates(date, today) >= 0) {
        throw conflict(ERROR_CODES.ATTENDANCE_DATE_IN_FUTURE);
      }
      // … and within this company's configured window (DOCUMENT 12 rule 13).
      if (daysBetween(date, today) > company.correctionWindowDays) {
        throw conflict(ERROR_CODES.CORRECTION_WINDOW_CLOSED);
      }

      const checkIn =
        dto.requested_check_in === undefined
          ? null
          : requireInstant(dto.requested_check_in, 'requested_check_in');
      const checkOut =
        dto.requested_check_out === undefined
          ? null
          : requireInstant(dto.requested_check_out, 'requested_check_out');
      if (checkIn !== null && checkOut !== null && checkOut.getTime() <= checkIn.getTime()) {
        throw fieldError({ requested_check_out: ['end_before_start'] });
      }
      if (checkIn === null && checkOut === null && dto.requested_work_mode === undefined) {
        // A correction that requests nothing is not a correction. Refusing it
        // here means a reviewer never has to work out what was being asked.
        throw fieldError({ requested_check_in: ['required'] });
      }

      // One open request per employee per day: two pending corrections for the
      // same date would let an approver apply one and silently strand the
      // other against a record it no longer describes.
      const open = await tx.attendanceCorrectionRequest.findFirst({
        where: { employeeId, date: dateValue(date), status: 'pending' },
        select: { id: true },
      });
      if (open !== null) {
        throw conflict(ERROR_CODES.CORRECTION_ALREADY_PENDING);
      }

      const record = await tx.attendanceRecord.findFirst({
        where: { employeeId, date: dateValue(date) },
        select: { id: true },
      });

      const row = await tx.attendanceCorrectionRequest.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          employeeId,
          attendanceRecordId: record?.id ?? null,
          date: dateValue(date),
          requestedCheckIn: checkIn,
          requestedCheckOut: checkOut,
          requestedWorkMode: dto.requested_work_mode ?? null,
          reason: dto.reason,
          status: 'pending',
        },
        include: CORRECTION_INCLUDE,
      });

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_CORRECTION_REQUESTED',
        entityType: 'attendance_correction_request',
        entityId: row.id,
        newValues: {
          date: dto.date,
          requested_check_in: checkIn?.toISOString() ?? null,
          requested_check_out: checkOut?.toISOString() ?? null,
          requested_work_mode: dto.requested_work_mode ?? null,
          reason: dto.reason,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return correctionPayload(row);
    });
  }

  /**
   * Whose correction this is.
   *
   * A caller with `self` scope may only ever name themselves — passing
   * somebody else's id is refused rather than quietly ignored, because
   * silently rewriting the subject of a request is how an employee ends up
   * with a correction they never filed.
   */
  private async resolveSubject(
    tx: TenantClient,
    ctx: AuthContext,
    requested: string | undefined,
  ): Promise<string> {
    const scope = ctx.permissions.get('attendance.request_correction');
    if (scope === undefined) {
      throw forbidden();
    }
    if (scope === 'self' || requested === undefined) {
      if (ctx.callerEmployeeId === null) {
        throw forbidden();
      }
      if (requested !== undefined && requested !== ctx.callerEmployeeId) {
        throw forbidden();
      }
      return ctx.callerEmployeeId;
    }
    if (scope === 'team') {
      const reports = await tx.employee.findFirst({
        where: { id: requested, managerId: ctx.callerEmployeeId },
        select: { id: true },
      });
      if (reports === null) {
        throw forbidden();
      }
      return requested;
    }
    return requested;
  }

  async list(ctx: AuthContext, query: CorrectionListQueryDto): Promise<CorrectionList> {
    const page = resolvePage(query);
    // DOCUMENT 08 §4.5: the list is reachable with `approve_correction` **or**
    // as the requester. A caller with only `request_correction` gets their own,
    // which is the `self` scope of that permission.
    const permission = ctx.permissions.has('attendance.approve_correction')
      ? 'attendance.approve_correction'
      : 'attendance.request_correction';
    const scope = correctionScopeWhere(ctx, permission);

    const and: Prisma.AttendanceCorrectionRequestWhereInput[] = [scope];
    if (query.status !== undefined) {
      and.push({ status: { equals: query.status as CorrectionStatusValue } });
    }
    if (query.employee_id !== undefined) and.push({ employeeId: query.employee_id });
    if (query.from !== undefined) and.push({ date: { gte: dateValue(requireDate(query.from)) } });
    if (query.to !== undefined) and.push({ date: { lte: dateValue(requireDate(query.to)) } });
    const where: Prisma.AttendanceCorrectionRequestWhereInput = { AND: and };

    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.attendanceCorrectionRequest.findMany({
          where,
          include: CORRECTION_INCLUDE,
          orderBy: [{ date: 'desc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.attendanceCorrectionRequest.count({ where }),
      ]);
      return { items: rows.map(correctionPayload), total };
    });
  }

  async findOne(ctx: AuthContext, id: string): Promise<CorrectionPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.attendanceCorrectionRequest.findFirst({
        where: { id },
        include: CORRECTION_INCLUDE,
      });
      if (row === null) {
        throw notFound();
      }
      await this.assertReachable(tx, ctx, id);
      return correctionPayload(row);
    });
  }

  private async assertReachable(tx: TenantClient, ctx: AuthContext, id: string): Promise<void> {
    const permissions: ('attendance.approve_correction' | 'attendance.request_correction')[] = [];
    if (ctx.permissions.has('attendance.approve_correction')) {
      permissions.push('attendance.approve_correction');
    }
    if (ctx.permissions.has('attendance.request_correction')) {
      permissions.push('attendance.request_correction');
    }
    for (const permission of permissions) {
      const reachable = await tx.attendanceCorrectionRequest.findFirst({
        where: { AND: [{ id }, correctionScopeWhere(ctx, permission)] },
        select: { id: true },
      });
      if (reachable !== null) {
        return;
      }
    }
    throw forbidden();
  }

  // -- Decisions -------------------------------------------------------------

  async approve(
    ctx: AuthContext,
    id: string,
    dto: ApproveCorrectionDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<CorrectionPayload> {
    return this.tenant(ctx, async (tx) => {
      const request = await this.requirePending(tx, ctx, id);

      const employee = await tx.employee.findFirstOrThrow({
        where: { id: request.employeeId },
        select: { workScheduleId: true },
      });
      const date = calendarDateIn(request.date, 'UTC');
      // DOCUMENT 15 rule 12: a finalized payroll period freezes the day.
      await this.periods.assertOpen(tx, [date]);
      const context = await loadScheduleContext(tx, employee.workScheduleId, date, date);
      const day = dayFor(context, date, employee.workScheduleId);

      const existing = await tx.attendanceRecord.findFirst({
        where: { employeeId: request.employeeId, date: dateValue(date) },
      });

      // A field the request did not ask about keeps whatever the record
      // already had; an approver approves a change, not a replacement.
      const checkInAt = request.requestedCheckIn ?? existing?.checkInAt ?? null;
      const checkOutAt = request.requestedCheckOut ?? existing?.checkOutAt ?? null;
      const workMode = request.requestedWorkMode ?? existing?.workMode ?? null;

      const calculated = calculateDay({
        date,
        schedule: context.settings,
        day,
        checkInAt,
        checkOutAt,
        isHoliday: isHolidayOn(context, date),
      });

      const data = {
        workMode: checkInAt === null ? workMode : (workMode ?? 'office'),
        checkInAt,
        checkOutAt,
        workingMinutes: calculated.workingMinutes,
        overtimeMinutes: calculated.overtimeMinutes,
        lateMinutes: calculated.lateMinutes,
        status: calculated.status as never,
        source: 'correction' as const,
      };

      const before = existing === null ? null : attendanceAuditSnapshot(existing);
      const record =
        existing === null
          ? await tx.attendanceRecord.create({
              data: {
                id: generateId(),
                companyId: ctx.companyId,
                employeeId: request.employeeId,
                date: dateValue(date),
                createdBy: ctx.userId,
                ...data,
              },
            })
          : await tx.attendanceRecord.update({ where: { id: existing.id }, data });

      const row = await tx.attendanceCorrectionRequest.update({
        where: { id },
        data: {
          status: 'approved',
          reviewedBy: ctx.userId,
          reviewedAt: now,
          attendanceRecordId: record.id,
          ...(dto.review_note === undefined ? {} : { reviewNote: dto.review_note }),
        },
        include: CORRECTION_INCLUDE,
      });

      // DOCUMENT 04 B7: "approval writes both the attendance change and an
      // audit record" — both, in this transaction, or neither.
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_CORRECTION_APPROVED',
        entityType: 'attendance_correction_request',
        entityId: id,
        ...(before === null ? {} : { oldValues: before }),
        newValues: {
          ...attendanceAuditSnapshot(record),
          attendance_record_id: record.id,
          ...(dto.review_note === undefined ? {} : { review_note: dto.review_note }),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return correctionPayload(row);
    });
  }

  async reject(
    ctx: AuthContext,
    id: string,
    dto: RejectCorrectionDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<CorrectionPayload> {
    return this.tenant(ctx, async (tx) => {
      await this.requirePending(tx, ctx, id);
      const row = await tx.attendanceCorrectionRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          reviewedBy: ctx.userId,
          reviewedAt: now,
          reviewNote: dto.review_note,
        },
        include: CORRECTION_INCLUDE,
      });

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_CORRECTION_REJECTED',
        entityType: 'attendance_correction_request',
        entityId: id,
        newValues: { status: 'rejected', review_note: dto.review_note },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return correctionPayload(row);
    });
  }

  /**
   * DOCUMENT 12 ACTIONS — "cancel own pending correction". Audited as
   * `request.cancelled`: DOCUMENT 21's attendance group has no cancellation
   * action, and the withdrawal of a request is a material lifecycle step.
   */
  async cancel(
    ctx: AuthContext,
    id: string,
    origin: RequestOrigin = { ipAddress: null, userAgent: null },
  ): Promise<CorrectionPayload> {
    return this.tenant(ctx, async (tx) => {
      const request = await tx.attendanceCorrectionRequest.findFirst({
        where: { id },
        select: { id: true, employeeId: true, status: true },
      });
      if (request === null) {
        throw notFound();
      }
      // "Own", not "in scope": a manager cancelling somebody else's request
      // would be deciding it, and deciding is what approve and reject are for.
      if (request.employeeId !== ctx.callerEmployeeId) {
        throw forbidden();
      }
      if (request.status !== 'pending') {
        throw conflict(ERROR_CODES.CORRECTION_NOT_PENDING);
      }
      const row = await tx.attendanceCorrectionRequest.update({
        where: { id },
        data: { status: 'cancelled' },
        include: CORRECTION_INCLUDE,
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'REQUEST_CANCELLED',
        entityType: 'attendance_correction_request',
        entityId: id,
        oldValues: { status: 'pending' },
        newValues: { status: 'cancelled' },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return correctionPayload(row);
    });
  }

  private async requirePending(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<{
    employeeId: string;
    date: Date;
    requestedCheckIn: Date | null;
    requestedCheckOut: Date | null;
    requestedWorkMode: 'office' | 'wfh' | null;
  }> {
    const row = await tx.attendanceCorrectionRequest.findFirst({
      where: { id },
      select: {
        id: true,
        employeeId: true,
        date: true,
        status: true,
        requestedCheckIn: true,
        requestedCheckOut: true,
        requestedWorkMode: true,
      },
    });
    if (row === null) {
      throw notFound();
    }
    const reachable = await tx.attendanceCorrectionRequest.findFirst({
      where: { AND: [{ id }, correctionScopeWhere(ctx, 'attendance.approve_correction')] },
      select: { id: true },
    });
    if (reachable === null) {
      throw forbidden();
    }
    // OD-03: a `company`-scoped ADMIN reaches their own correction through
    // the scope above, so the refusal is explicit. (A manager's `team` scope
    // never includes themselves.)
    if (row.employeeId === ctx.callerEmployeeId) {
      throw new AppException(ERROR_CODES.REQUEST_SELF_REVIEW, 403);
    }
    if (row.status !== 'pending') {
      throw conflict(ERROR_CODES.CORRECTION_NOT_PENDING);
    }
    return {
      employeeId: row.employeeId,
      date: row.date,
      requestedCheckIn: row.requestedCheckIn,
      requestedCheckOut: row.requestedCheckOut,
      requestedWorkMode: row.requestedWorkMode,
    };
  }
}

function requireDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (parsed === null) {
    throw fieldError({ date: ['invalid'] });
  }
  return parsed;
}

function requireInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw fieldError({ [field]: ['invalid'] });
  }
  return parsed;
}
