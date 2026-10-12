/**
 * Attendance — DOCUMENT 25 Phase 6, DOCUMENT 08 §4.4, DOCUMENT 12.
 *
 * The rules that carry the weight:
 *
 *   - **One record per employee per day** (DOCUMENT 12 rule 1). The unique
 *     constraint is the enforcement; this service turns the violation into the
 *     documented 409 rather than checking first, because a check-then-write
 *     races and the constraint does not — which is exactly DOCUMENT 12's "two
 *     devices check in simultaneously".
 *   - **Server time is authoritative** (DOCUMENT 12 "Clock skew"). Check-in and
 *     check-out take no timestamp from the client at all.
 *   - **The day is the schedule's day** (DOCUMENT 12 "Timezone"). Which
 *     calendar date a check-in belongs to is decided in the schedule's zone,
 *     never the browser's and never the server's own locale.
 *   - **Every derived value comes from the schedule** (DOCUMENT 27 RULE 12).
 *     This file contains no working hours, no week, and no default day; it
 *     loads `work_schedules` / `work_schedule_days` and hands them to the pure
 *     engine in `calculation.ts`.
 *   - **Derived values are written when the day is evaluated**, not recomputed
 *     on read — DOCUMENT 12's "schedule changes mid-month" requires each day to
 *     keep the judgement made against the schedule in effect on that date.
 *   - **Every admin adjustment is audited with old and new values and a
 *     required reason** (DOCUMENT 12 rule 11, DOCUMENT 21).
 *
 *   - **A finalized payroll period freezes its attendance** (DOCUMENT 12,
 *     DOCUMENT 15 rule 12, Phase 11): check-in, check-out and an admin
 *     adjustment on a date inside a finalized, paid or adjusted period are
 *     refused with 409 `PAYROLL_PERIOD_FINALIZED`; the way forward is a
 *     payroll adjustment.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { PayrollPeriodGuard } from '../payroll/payroll-period-guard.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  conflict,
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { employeeScopeWhere } from '../employees/employee-query.js';

import { calculateDay } from './calculation.js';
import type { AttendanceStatusValue } from './calculation.js';
import {
  ATTENDANCE_INCLUDE,
  attendanceAuditSnapshot,
  attendanceEmployeeRef,
  attendancePayload,
} from './attendance-payload.js';
import type {
  AttendanceEmployeeRef,
  AttendancePayload,
  AttendanceRow,
} from './attendance-payload.js';
import {
  attendanceScopeWhere,
  dateValue,
  forbidden,
  LIST_ORDER,
  listWhere,
} from './attendance-query.js';
import { dayFor, isHolidayOn, loadScheduleContext } from './schedule-context.js';
import type {
  AdjustAttendanceDto,
  AttendanceListQueryDto,
  CheckInDto,
  EmployeeAttendanceQueryDto,
  MonthlyQueryDto,
  SummaryQueryDto,
  WorkModeValue,
} from './dto/attendance.dto.js';
import {
  calendarDateIn,
  compareDates,
  eachDay,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from './zoned-time.js';
import type { CalendarDate } from './zoned-time.js';

export interface AttendanceList {
  readonly items: readonly AttendancePayload[];
  readonly total: number;
}

/** DOCUMENT 08 §4.4 `GET /attendance/today` — the caller's own state. */
export interface TodayState {
  readonly date: string;
  readonly is_working_day: boolean;
  readonly is_holiday: boolean;
  readonly scheduled_start_at: string | null;
  readonly scheduled_end_at: string | null;
  readonly record: AttendancePayload | null;
  readonly can_check_in: boolean;
  readonly can_check_out: boolean;
}

export interface MonthlyCell {
  readonly date: string;
  readonly status: AttendanceStatusValue | null;
  readonly work_mode: 'office' | 'wfh' | null;
  readonly record_id: string | null;
}

export interface MonthlyRow {
  readonly employee: AttendancePayload['employee'];
  readonly days: readonly MonthlyCell[];
  readonly totals: Readonly<Record<string, number>>;
}

/** DOCUMENT 08 §4.3 `GET /employees/{id}/attendance` — one employee's month. */
export interface EmployeeMonth extends MonthlyRow {
  readonly month: string;
  readonly records: readonly AttendancePayload[];
}

export interface MonthlyMatrix {
  readonly month: string;
  readonly days: readonly string[];
  readonly rows: readonly MonthlyRow[];
}

const COUNTED_STATUSES: readonly AttendanceStatusValue[] = [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
  'holiday',
  'weekend',
  'pending',
];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * One employee's month: a cell per day (empty where nothing is recorded) and
 * a count per status. Shared by the company matrix and the employee profile
 * month, so the two can never total a month differently.
 */
function monthlyRow(
  employee: AttendanceEmployeeRef,
  rows: readonly AttendanceRow[],
  days: readonly CalendarDate[],
): MonthlyRow {
  const byDate = new Map(rows.map((row) => [row.date.toISOString().slice(0, 10), row]));
  const totals: Record<string, number> = {};
  for (const status of COUNTED_STATUSES) {
    totals[status] = 0;
  }
  const cells = days.map((day) => {
    const key = formatCalendarDate(day);
    const record = byDate.get(key);
    if (record === undefined) {
      return { date: key, status: null, work_mode: null, record_id: null };
    }
    totals[record.status] = (totals[record.status] ?? 0) + 1;
    return {
      date: key,
      status: record.status as AttendanceStatusValue,
      work_mode: record.workMode,
      record_id: record.id,
    };
  });
  return { employee, days: cells, totals };
}

/** `YYYY-MM-DD` → a calendar date, or 422 naming the field. */
function requireDate(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (parsed === null) {
    throw fieldError({ date: ['invalid'] });
  }
  return parsed;
}

/**
 * An ISO instant from a correction or an adjustment. A date that does not
 * exist is 422, not a 500 — the same treatment Phase 5 gave `joining_date`.
 */
function requireInstant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw fieldError({ [field]: ['invalid'] });
  }
  return parsed;
}

function instantFor(date: CalendarDate, minutes: number, timeZone: string): string {
  return instantAt(date, minutes, timeZone).toISOString();
}

/**
 * DOCUMENT 08 §4.4 — `?date=` or `?from=&to=`. One day is the daily board;
 * a range is a history. The window is never unbounded, and `to` before `from`
 * is a 422 rather than a silently empty list.
 */
function resolveWindow(query: AttendanceListQueryDto): { from: CalendarDate; to: CalendarDate } {
  if (query.date !== undefined) {
    const day = requireDate(query.date);
    return { from: day, to: day };
  }
  if (query.from === undefined || query.to === undefined) {
    throw fieldError({ from: ['required'], to: ['required'] });
  }
  const from = requireDate(query.from);
  const to = requireDate(query.to);
  if (compareDates(from, to) > 0) {
    throw fieldError({ to: ['end_before_start'] });
  }
  return { from, to };
}

/** `YYYY-MM` → the first and last day of that month. */
export function parseMonth(value: string): { from: CalendarDate; to: CalendarDate } {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) {
    throw fieldError({ month: ['invalid'] });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw fieldError({ month: ['invalid'] });
  }
  // Day 0 of the next month is the last day of this one, which is what keeps
  // February correct in a leap year without a table of month lengths.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: { year, month, day: 1 }, to: { year, month, day: last } };
}

@Injectable()
export class AttendanceService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(PayrollPeriodGuard) private readonly periods: PayrollPeriodGuard,
  ) {
    super(prisma, audit);
  }

  // -- The caller's own day --------------------------------------------------

  /**
   * The employee record the caller acts as. `self`-scoped attendance actions
   * are meaningless without one, and a caller who has none is refused rather
   * than silently acting on somebody else.
   */
  private async requireCallerEmployee(
    tx: TenantClient,
    ctx: AuthContext,
  ): Promise<{ id: string; workScheduleId: string }> {
    if (ctx.callerEmployeeId === null) {
      throw forbidden();
    }
    const employee = await tx.employee.findFirst({
      where: { id: ctx.callerEmployeeId },
      select: { id: true, workScheduleId: true, status: true },
    });
    if (employee === null) {
      throw forbidden();
    }
    if (employee.status !== 'active') {
      throw conflict(ERROR_CODES.EMPLOYEE_NOT_ACTIVE);
    }
    return { id: employee.id, workScheduleId: employee.workScheduleId };
  }

  /**
   * "Today" is today *in the schedule's zone* — DOCUMENT 12 "Timezone". A
   * server in UTC and an employee in Cairo disagree about the date for two
   * hours every night, and the employee's schedule is what settles it.
   */
  private async todayFor(
    tx: TenantClient,
    workScheduleId: string,
    now: Date,
  ): Promise<{ date: CalendarDate; context: Awaited<ReturnType<typeof loadScheduleContext>> }> {
    const schedule = await tx.workSchedule.findUniqueOrThrow({
      where: { id: workScheduleId },
      select: { timezone: true },
    });
    const date = calendarDateIn(now, schedule.timezone);
    const context = await loadScheduleContext(tx, workScheduleId, date, date);
    return { date, context };
  }

  async today(ctx: AuthContext, now: Date = new Date()): Promise<TodayState> {
    return this.tenant(ctx, async (tx) => {
      const employee = await this.requireCallerEmployee(tx, ctx);
      const { date, context } = await this.todayFor(tx, employee.workScheduleId, now);
      const day = dayFor(context, date, employee.workScheduleId);
      const holiday = isHolidayOn(context, date);

      const record = await tx.attendanceRecord.findFirst({
        where: { employeeId: employee.id, date: dateValue(date) },
        include: ATTENDANCE_INCLUDE,
      });

      const payload = record === null ? null : attendancePayload(record);
      return {
        date: formatCalendarDate(date),
        is_working_day: day.isWorkingDay,
        is_holiday: holiday,
        scheduled_start_at:
          day.startMinutes === null
            ? null
            : instantFor(date, day.startMinutes, context.settings.timezone),
        scheduled_end_at:
          day.endMinutes === null
            ? null
            : instantFor(date, day.endMinutes, context.settings.timezone),
        record: payload,
        // DOCUMENT 04 C1: never render an action whose result is unknown. The
        // server decides what is possible; the card only draws it.
        can_check_in: record === null || record.checkInAt === null,
        can_check_out: record !== null && record.checkInAt !== null && record.checkOutAt === null,
      };
    });
  }

  // -- Check in / check out --------------------------------------------------

  async checkIn(
    ctx: AuthContext,
    dto: CheckInDto,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<AttendancePayload> {
    return this.tenant(ctx, async (tx) => {
      const employee = await this.requireCallerEmployee(tx, ctx);
      const { date, context } = await this.todayFor(tx, employee.workScheduleId, now);
      const day = dayFor(context, date, employee.workScheduleId);
      const holiday = isHolidayOn(context, date);
      await this.periods.assertOpen(tx, [date]);

      // DOCUMENT 12 "ERROR STATES": a rest day is a confirmation, not a
      // refusal. Refused once so the screen can ask; allowed when confirmed.
      if ((!day.isWorkingDay || holiday) && dto.confirm_non_working_day !== true) {
        throw conflict(ERROR_CODES.NON_WORKING_DAY);
      }

      const existing = await tx.attendanceRecord.findFirst({
        where: { employeeId: employee.id, date: dateValue(date) },
        include: ATTENDANCE_INCLUDE,
      });

      // A generated weekend/holiday/absent row is not a check-in; the employee
      // turning up converts it rather than being refused by it.
      if (existing !== null && existing.checkInAt !== null) {
        // The time DOCUMENT 12's message quotes ("… already checked in at
        // 08:57") is not put in the error body: the card that raised this
        // already reads `GET /attendance/today`, and refetching it after the
        // refusal shows the real record rather than a second copy of it
        // travelling inside an error envelope DOCUMENT 08 §2 does not define.
        throw conflict(ERROR_CODES.ALREADY_CHECKED_IN);
      }

      const calculated = calculateDay({
        date,
        schedule: context.settings,
        day,
        checkInAt: now,
        checkOutAt: null,
        isHoliday: holiday,
      });

      const data = {
        workMode: dto.work_mode,
        checkInAt: now,
        checkOutAt: null,
        workingMinutes: calculated.workingMinutes,
        overtimeMinutes: calculated.overtimeMinutes,
        lateMinutes: calculated.lateMinutes,
        status: calculated.status as never,
        source: 'self' as const,
        createdBy: ctx.userId,
      };

      let row: AttendanceRow;
      try {
        row =
          existing === null
            ? await tx.attendanceRecord.create({
                data: {
                  id: generateId(),
                  companyId: ctx.companyId,
                  employeeId: employee.id,
                  date: dateValue(date),
                  ...data,
                },
                include: ATTENDANCE_INCLUDE,
              })
            : await tx.attendanceRecord.update({
                where: { id: existing.id },
                data,
                include: ATTENDANCE_INCLUDE,
              });
      } catch (error) {
        // DOCUMENT 12: "two devices check in simultaneously" — the unique
        // constraint makes the loser a clean conflict, not a duplicate row.
        if (isUniqueViolation(error)) {
          throw conflict(ERROR_CODES.ALREADY_CHECKED_IN);
        }
        throw error;
      }

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_CHECKED_IN',
        entityType: 'attendance_record',
        entityId: row.id,
        newValues: attendanceAuditSnapshot(row),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return attendancePayload(row);
    });
  }

  async checkOut(
    ctx: AuthContext,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<AttendancePayload> {
    return this.tenant(ctx, async (tx) => {
      const employee = await this.requireCallerEmployee(tx, ctx);
      const { date, context } = await this.todayFor(tx, employee.workScheduleId, now);
      const day = dayFor(context, date, employee.workScheduleId);

      await this.periods.assertOpen(tx, [date]);
      const existing = await tx.attendanceRecord.findFirst({
        where: { employeeId: employee.id, date: dateValue(date) },
      });

      // DOCUMENT 12 rule 14 — check-out without check-in is impossible here;
      // the employee is directed to the correction flow by the error code.
      if (existing === null || existing.checkInAt === null) {
        throw conflict(ERROR_CODES.NOT_CHECKED_IN);
      }
      if (existing.checkOutAt !== null) {
        throw conflict(ERROR_CODES.ALREADY_CHECKED_OUT);
      }

      const before = attendanceAuditSnapshot(existing);
      const calculated = calculateDay({
        date,
        schedule: context.settings,
        day,
        checkInAt: existing.checkInAt,
        checkOutAt: now,
        isHoliday: isHolidayOn(context, date),
      });

      const row = await tx.attendanceRecord.update({
        where: { id: existing.id },
        data: {
          checkOutAt: now,
          workingMinutes: calculated.workingMinutes,
          overtimeMinutes: calculated.overtimeMinutes,
          lateMinutes: calculated.lateMinutes,
          status: calculated.status as never,
        },
        include: ATTENDANCE_INCLUDE,
      });

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_CHECKED_OUT',
        entityType: 'attendance_record',
        entityId: row.id,
        oldValues: before,
        newValues: attendanceAuditSnapshot(row),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return attendancePayload(row);
    });
  }

  // -- Reads -----------------------------------------------------------------

  async list(ctx: AuthContext, query: AttendanceListQueryDto): Promise<AttendanceList> {
    const page = resolvePage(query);
    const window = resolveWindow(query);
    const scope = attendanceScopeWhere(ctx, 'attendance.view');
    const where = listWhere(scope, {
      ...window,
      ...(query.department_id === undefined ? {} : { departmentId: query.department_id }),
      ...(query.employee_id === undefined ? {} : { employeeId: query.employee_id }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.work_mode === undefined ? {} : { workMode: query.work_mode }),
    });

    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.attendanceRecord.findMany({
          where,
          include: ATTENDANCE_INCLUDE,
          orderBy: LIST_ORDER,
          skip: page.skip,
          take: page.take,
        }),
        tx.attendanceRecord.count({ where }),
      ]);
      return { items: rows.map(attendancePayload), total };
    });
  }

  async findOne(ctx: AuthContext, id: string): Promise<AttendancePayload> {
    return this.tenant(ctx, async (tx) => {
      // Fetched within the tenant first: another company's id is 404 because
      // row-level security has already hidden it. Outside the caller's scope
      // but inside the tenant is 403 — DOCUMENT 09 §4.
      const row = await tx.attendanceRecord.findFirst({
        where: { id },
        include: ATTENDANCE_INCLUDE,
      });
      if (row === null) {
        throw notFound();
      }
      const scope = attendanceScopeWhere(ctx, 'attendance.view');
      const reachable = await tx.attendanceRecord.findFirst({
        where: { AND: [{ id }, scope] },
        select: { id: true },
      });
      if (reachable === null) {
        throw forbidden();
      }
      return attendancePayload(row);
    });
  }

  /** DOCUMENT 08 §4.4 `GET /attendance/summary` — the dashboard counts. */
  async summary(
    ctx: AuthContext,
    query: SummaryQueryDto,
    now: Date = new Date(),
  ): Promise<Record<string, number>> {
    const scope = attendanceScopeWhere(ctx, 'attendance.view');
    return this.tenant(ctx, async (tx) => {
      const date =
        query.date === undefined ? await this.companyToday(tx, now) : requireDate(query.date);
      const grouped = await tx.attendanceRecord.groupBy({
        by: ['status'],
        where: { AND: [scope, { date: dateValue(date) }] },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      for (const status of COUNTED_STATUSES) {
        counts[status] = 0;
      }
      for (const group of grouped) {
        counts[group.status] = group._count._all;
      }
      counts['total'] = grouped.reduce((sum, group) => sum + group._count._all, 0);
      return counts;
    });
  }

  /**
   * DOCUMENT 04 B6 — employees on rows, days on columns.
   *
   * Built from one query per month rather than one per cell: a 40-employee
   * month is 1,200 cells, and a request per cell is how a matrix screen
   * becomes unusable.
   */
  async monthly(ctx: AuthContext, query: MonthlyQueryDto): Promise<MonthlyMatrix> {
    const month = parseMonth(query.month);
    const scope = attendanceScopeWhere(ctx, 'attendance.view');
    const days = eachDay(month.from, month.to);

    return this.tenant(ctx, async (tx) => {
      const rows = await tx.attendanceRecord.findMany({
        where: listWhere(scope, {
          from: month.from,
          to: month.to,
          ...(query.department_id === undefined ? {} : { departmentId: query.department_id }),
          ...(query.employee_id === undefined ? {} : { employeeId: query.employee_id }),
        }),
        include: ATTENDANCE_INCLUDE,
        orderBy: [{ employee: { employeeCode: 'asc' } }, { date: 'asc' }],
      });

      const byEmployee = new Map<string, AttendanceRow[]>();
      for (const row of rows) {
        const list = byEmployee.get(row.employeeId) ?? [];
        list.push(row);
        byEmployee.set(row.employeeId, list);
      }

      const matrixRows: MonthlyRow[] = [];
      for (const [, employeeRows] of byEmployee) {
        const first = employeeRows[0] as AttendanceRow;
        matrixRows.push(monthlyRow(attendancePayload(first).employee, employeeRows, days));
      }

      return {
        month: query.month,
        days: days.map(formatCalendarDate),
        rows: matrixRows,
      };
    });
  }

  /**
   * DOCUMENT 08 §4.3 `GET /employees/{id}/attendance?month=YYYY-MM` — one
   * employee's month, for the employee profile.
   *
   * The same month row the matrix builds (`monthlyRow`), plus the records
   * themselves. Scope is checked against the employee rather than the records,
   * so an in-scope employee with no records yet is an empty month, not a 403:
   * another company's employee is 404 (row-level security has already hidden
   * them), an in-tenant employee outside the caller's `attendance.view` scope
   * is 403 — DOCUMENT 09 §4, the same order as `GET /employees/{id}`.
   */
  async employeeMonth(
    ctx: AuthContext,
    employeeId: string,
    query: EmployeeAttendanceQueryDto,
  ): Promise<EmployeeMonth> {
    const month = parseMonth(query.month);
    const days = eachDay(month.from, month.to);

    return this.tenant(ctx, async (tx) => {
      const exists = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: { id: true },
      });
      if (exists === null) {
        throw notFound();
      }
      const employee = await tx.employee.findFirst({
        where: {
          AND: [{ id: employeeId, deletedAt: null }, employeeScopeWhere(ctx, 'attendance.view')],
        },
        select: ATTENDANCE_INCLUDE.employee.select,
      });
      if (employee === null) {
        throw forbidden();
      }

      const rows = await tx.attendanceRecord.findMany({
        where: listWhere({}, { from: month.from, to: month.to, employeeId }),
        include: ATTENDANCE_INCLUDE,
        orderBy: [{ date: 'asc' }],
      });
      return {
        month: query.month,
        ...monthlyRow(attendanceEmployeeRef(employee), rows, days),
        records: rows.map(attendancePayload),
      };
    });
  }

  private async companyToday(tx: TenantClient, now: Date): Promise<CalendarDate> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    return calendarDateIn(now, company.timezone);
  }

  // -- Admin adjustment ------------------------------------------------------

  /**
   * `PATCH /attendance/{id}` — DOCUMENT 12 rule 11.
   *
   * The reason is required by the DTO and kept in the audit record with the
   * old and new values. Everything the adjustment does not name is left alone,
   * and the derived minutes are recomputed from the schedule in effect on that
   * record's date whenever the times change — an admin setting a check-out
   * must not leave yesterday's `working_minutes` behind it.
   */
  async adjust(
    ctx: AuthContext,
    id: string,
    dto: AdjustAttendanceDto,
    origin: RequestOrigin,
  ): Promise<AttendancePayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await tx.attendanceRecord.findFirst({
        where: { id },
        include: { employee: { select: { workScheduleId: true } } },
      });
      if (existing === null) {
        throw notFound();
      }

      const checkInAt =
        dto.check_in_at === undefined
          ? existing.checkInAt
          : dto.check_in_at === null
            ? null
            : requireInstant(dto.check_in_at, 'check_in_at');
      const checkOutAt =
        dto.check_out_at === undefined
          ? existing.checkOutAt
          : dto.check_out_at === null
            ? null
            : requireInstant(dto.check_out_at, 'check_out_at');

      if (
        checkInAt !== null &&
        checkOutAt !== null &&
        checkOutAt.getTime() <= checkInAt.getTime()
      ) {
        throw fieldError({ check_out_at: ['invalid'] });
      }
      const workMode =
        dto.work_mode === undefined ? existing.workMode : (dto.work_mode as WorkModeValue | null);
      if (checkInAt !== null && workMode === null) {
        // The table's own CHECK says the same thing; failing here names the
        // field instead of surfacing a constraint name.
        throw fieldError({ work_mode: ['required'] });
      }

      const date = calendarDateIn(existing.date, 'UTC');
      await this.periods.assertOpen(tx, [date]);
      const context = await loadScheduleContext(tx, existing.employee.workScheduleId, date, date);
      const day = dayFor(context, date, existing.employee.workScheduleId);
      const calculated = calculateDay({
        date,
        schedule: context.settings,
        day,
        checkInAt,
        checkOutAt,
        isHoliday: isHolidayOn(context, date),
      });

      const before = attendanceAuditSnapshot(existing);
      const row = await tx.attendanceRecord.update({
        where: { id },
        data: {
          workMode,
          checkInAt,
          checkOutAt,
          workingMinutes: calculated.workingMinutes,
          overtimeMinutes: calculated.overtimeMinutes,
          lateMinutes: calculated.lateMinutes,
          // An explicit status wins over the derived one: DOCUMENT 12's
          // `on_leave` has no rule the engine could apply, and an admin
          // correcting a day is allowed to say what it was.
          status: (dto.status ?? calculated.status) as never,
          source: 'admin' as const,
          ...(dto.note === undefined ? {} : { note: dto.note }),
        },
        include: ATTENDANCE_INCLUDE,
      });

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTENDANCE_ADJUSTED_BY_ADMIN',
        entityType: 'attendance_record',
        entityId: row.id,
        oldValues: before,
        // DOCUMENT 12 rule 11 requires the reason; DOCUMENT 06 §3.10 gives the
        // table no column for it, and DOCUMENT 21 is where "why" belongs.
        newValues: { ...attendanceAuditSnapshot(row), reason: dto.reason },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return attendancePayload(row);
    });
  }
}
