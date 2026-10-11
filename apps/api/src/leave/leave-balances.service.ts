/**
 * Leave balances — DOCUMENT 16 rules 1, 3, 14, OD-16; DOCUMENT 08 §4.6
 * `/leave-balances`.
 *
 *   - **Per employee, per type, per year** (rule 1), unique in the database.
 *   - **Created on first need, pro-rated** (OD-16, approved): DOCUMENT 05
 *     FLOW 02 creates "leave balances for the year" with the employee. Here
 *     the row for any (employee, paid type, year) is written the first time
 *     anything needs it, with `total_days` = the type's
 *     `default_days_per_year` pro-rated by month worked. The result is the
 *     same for an employee created before Phase 10 or after, and for a year
 *     nobody has reached yet. Unpaid types have no balance (rule 7).
 *   - **Remaining is computed, never stored.**
 *   - **Every write locks the row** (`SELECT … FOR UPDATE`) inside the
 *     caller's transaction, so two requests can never both spend the same
 *     days.
 *   - **Adjustments** (rule 14) change the entitlement only — `total_days`
 *     and `carried_over_days` — with a reason, audited old/new. `used_days`
 *     and `pending_days` are history that follows the requests.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import type { Decimal } from '@ufuq/money';

import { calendarDateIn } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuditEntry } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type { AdjustLeaveBalanceDto, ListLeaveBalancesQueryDto } from './dto/leave.dto.js';
import { balanceSnapshot, LEAVE_BALANCE_INCLUDE, leaveBalancePayload } from './leave-payload.js';
import type { LeaveBalancePayload, LeaveBalanceRow } from './leave-payload.js';
import { forbidden, leaveScopeWhere, leaveVisibleWhere } from './leave-query.js';
import type { EmployeeOwnedWhere } from './leave-query.js';
import { days, proratedAllowance, remaining } from './leave-rules.js';

export interface BalanceSubject {
  readonly id: string;
  readonly joiningDate: Date;
}

export interface BalanceType {
  readonly id: string;
  readonly defaultDaysPerYear: { toString(): string };
}

/** The four figures as exact decimals. */
export interface LockedBalance {
  readonly id: string;
  readonly totalDays: Decimal;
  readonly usedDays: Decimal;
  readonly pendingDays: Decimal;
  readonly carriedOverDays: Decimal;
}

/** The `employees` rows a leave scope reaches — for the employee table itself. */
export function employeeWhereFor(scope: EmployeeOwnedWhere): Prisma.EmployeeWhereInput {
  if ('OR' in scope) {
    return { OR: scope.OR.map(employeeWhereFor) };
  }
  if ('employeeId' in scope) return { id: scope.employeeId };
  if ('employee' in scope) return { managerId: scope.employee.managerId };
  return {};
}

@Injectable()
export class LeaveBalancesService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma);
  }

  // -- Building blocks every leave write uses ---------------------------------

  /** The company's calendar day (DOCUMENT 11 §9 — never the server's). */
  async today(tx: TenantClient, now: Date = new Date()): Promise<CalendarDate> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    return calendarDateIn(now, company.timezone);
  }

  /** Write the year's row if it does not exist yet, pro-rated (OD-16). Never changes an existing row. */
  async ensure(
    tx: TenantClient,
    companyId: string,
    employee: BalanceSubject,
    type: BalanceType,
    year: number,
  ): Promise<void> {
    const existing = await tx.leaveBalance.findUnique({
      where: {
        employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: type.id, year },
      },
      select: { id: true },
    });
    if (existing !== null) return;
    const joining = calendarDateIn(employee.joiningDate, 'UTC');
    try {
      await tx.leaveBalance.create({
        data: {
          id: generateId(),
          companyId,
          employeeId: employee.id,
          leaveTypeId: type.id,
          year,
          totalDays: proratedAllowance(days(type.defaultDaysPerYear), joining, year).toString(),
        },
      });
    } catch (error) {
      // A concurrent request created it first; the row is what we wanted.
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Ensure, then lock the row for the rest of the transaction and read it. */
  async lock(
    tx: TenantClient,
    companyId: string,
    employee: BalanceSubject,
    type: BalanceType,
    year: number,
  ): Promise<LockedBalance> {
    await this.ensure(tx, companyId, employee, type, year);
    await tx.$queryRaw`SELECT id FROM leave_balances
      WHERE employee_id = ${employee.id}::uuid AND leave_type_id = ${type.id}::uuid AND year = ${year}
      FOR UPDATE`;
    const row = await tx.leaveBalance.findUniqueOrThrow({
      where: {
        employeeId_leaveTypeId_year: { employeeId: employee.id, leaveTypeId: type.id, year },
      },
    });
    return {
      id: row.id,
      totalDays: days(row.totalDays),
      usedDays: days(row.usedDays),
      pendingDays: days(row.pendingDays),
      carriedOverDays: days(row.carriedOverDays),
    };
  }

  /** Move days between `pending_days` and `used_days` on a locked row. */
  async move(
    tx: TenantClient,
    balance: LockedBalance,
    change: { readonly pending?: Decimal; readonly used?: Decimal },
  ): Promise<void> {
    const pending =
      change.pending === undefined ? balance.pendingDays : balance.pendingDays.add(change.pending);
    const used = change.used === undefined ? balance.usedDays : balance.usedDays.add(change.used);
    await tx.leaveBalance.update({
      where: { id: balance.id },
      data: { pendingDays: pending.toString(), usedDays: used.toString() },
    });
  }

  /** Every active paid type's row for these employees and year, written if missing. */
  async ensureForEmployees(
    tx: TenantClient,
    companyId: string,
    employees: readonly BalanceSubject[],
    year: number,
  ): Promise<void> {
    const types = await tx.leaveType.findMany({
      where: { deletedAt: null, isPaid: true },
      select: { id: true, defaultDaysPerYear: true },
    });
    for (const employee of employees) {
      for (const type of types) {
        await this.ensure(tx, companyId, employee, type, year);
      }
    }
  }

  // -- GET /leave-balances/me -------------------------------------------------

  /** The caller's balances for a year (default: this year), one per active paid type. */
  async mine(ctx: AuthContext, year?: number): Promise<readonly LeaveBalancePayload[]> {
    const employeeId = ctx.callerEmployeeId;
    if (employeeId === null) {
      return [];
    }
    return this.tenant(ctx, async (tx) => {
      const target = year ?? (await this.today(tx)).year;
      const employee = await tx.employee.findFirstOrThrow({
        where: { id: employeeId },
        select: { id: true, joiningDate: true },
      });
      await this.ensureForEmployees(tx, ctx.companyId, [employee], target);
      const rows = await tx.leaveBalance.findMany({
        where: { employeeId, year: target, leaveType: { deletedAt: null, isPaid: true } },
        include: LEAVE_BALANCE_INCLUDE,
        orderBy: [{ leaveType: { nameEn: 'asc' } }],
      });
      return rows.map(leaveBalancePayload);
    });
  }

  // -- GET /leave-balances ----------------------------------------------------

  async list(
    ctx: AuthContext,
    query: ListLeaveBalancesQueryDto,
  ): Promise<{ readonly items: readonly LeaveBalancePayload[]; readonly total: number }> {
    const page = resolvePage(query);
    const visible = leaveVisibleWhere(ctx);
    return this.tenant(ctx, async (tx) => {
      const year = query.year ?? (await this.today(tx)).year;
      // One employee asked for by name: their rows are written if missing, so
      // a profile or an ADMIN about to adjust always sees every type.
      if (query.employee_id !== undefined) {
        const employee = await tx.employee.findFirst({
          where: { AND: [{ id: query.employee_id }, employeeWhereFor(visible)] },
          select: { id: true, joiningDate: true },
        });
        if (employee !== null) {
          await this.ensureForEmployees(tx, ctx.companyId, [employee], year);
        }
      }
      const where: Prisma.LeaveBalanceWhereInput = {
        AND: [
          visible as Prisma.LeaveBalanceWhereInput,
          { year, leaveType: { deletedAt: null } },
          ...(query.employee_id === undefined ? [] : [{ employeeId: query.employee_id }]),
          ...(query.leave_type_id === undefined ? [] : [{ leaveTypeId: query.leave_type_id }]),
        ],
      };
      const [rows, total] = await Promise.all([
        tx.leaveBalance.findMany({
          where,
          include: LEAVE_BALANCE_INCLUDE,
          orderBy: [
            { employee: { firstName: 'asc' } },
            { leaveType: { nameEn: 'asc' } },
            { id: 'asc' },
          ],
          skip: page.skip,
          take: page.take,
        }),
        tx.leaveBalance.count({ where }),
      ]);
      return { items: rows.map(leaveBalancePayload), total };
    });
  }

  /** The balances of one type for the years a leave request touches — the B13 "employee context". */
  async forRequest(
    tx: TenantClient,
    employeeId: string,
    leaveTypeId: string,
    years: readonly number[],
  ): Promise<readonly LeaveBalancePayload[]> {
    const rows = await tx.leaveBalance.findMany({
      where: { employeeId, leaveTypeId, year: { in: [...years] } },
      include: LEAVE_BALANCE_INCLUDE,
      orderBy: { year: 'asc' },
    });
    return rows.map(leaveBalancePayload);
  }

  // -- PATCH /leave-balances/{id} ---------------------------------------------

  async adjust(
    ctx: AuthContext,
    id: string,
    dto: AdjustLeaveBalanceDto,
    origin: RequestOrigin,
  ): Promise<LeaveBalancePayload> {
    if (dto.total_days === undefined && dto.carried_over_days === undefined) {
      throw fieldError({ total_days: ['required'] });
    }
    const audits: AuditEntry[] = [];
    const adjusted = await this.tenant(ctx, async (tx) => {
      const found = await tx.leaveBalance.findFirst({ where: { id }, select: { id: true } });
      if (found === null) {
        throw notFound();
      }
      const inScope = await tx.leaveBalance.findFirst({
        where: {
          AND: [
            { id },
            leaveScopeWhere(ctx, 'leave.adjust_balance') as Prisma.LeaveBalanceWhereInput,
          ],
        },
        select: { id: true },
      });
      if (inScope === null) {
        throw forbidden();
      }
      await tx.$queryRaw`SELECT id FROM leave_balances WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.leaveBalance.findUniqueOrThrow({
        where: { id },
        include: { leaveType: { select: { allowsNegativeBalance: true } } },
      });
      const next = {
        totalDays: dto.total_days === undefined ? days(before.totalDays) : days(dto.total_days),
        carriedOverDays:
          dto.carried_over_days === undefined
            ? days(before.carriedOverDays)
            : days(dto.carried_over_days),
        usedDays: days(before.usedDays),
        pendingDays: days(before.pendingDays),
      };
      // An entitlement below what is already taken or held would leave a
      // negative balance the type does not allow.
      if (remaining(next).isNegative() && !before.leaveType.allowsNegativeBalance) {
        throw fieldError({ total_days: ['below_committed'] });
      }
      const oldValues = balanceSnapshot(before);
      const newValues = {
        total_days: next.totalDays.toString(),
        carried_over_days: next.carriedOverDays.toString(),
      };
      const changed = Object.keys(newValues).filter(
        (key) => oldValues[key] !== newValues[key as keyof typeof newValues],
      );
      const row = await tx.leaveBalance.update({
        where: { id },
        data: { totalDays: newValues.total_days, carriedOverDays: newValues.carried_over_days },
        include: LEAVE_BALANCE_INCLUDE,
      });
      if (changed.length > 0) {
        audits.push({
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'LEAVE_BALANCE_ADJUSTED',
          entityType: 'leave_balance',
          entityId: id,
          oldValues: Object.fromEntries(changed.map((key) => [key, oldValues[key] ?? null])),
          newValues: {
            ...Object.fromEntries(
              changed.map((key) => [key, newValues[key as keyof typeof newValues]]),
            ),
            reason: dto.reason,
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return leaveBalancePayload(row as LeaveBalanceRow);
    });
    await this.audit.dispatch(audits);
    return adjusted;
  }
}
