/**
 * Payroll — DOCUMENT 15, DOCUMENT 05 FLOWs 14–16, DOCUMENT 08 §4.10, OD-06 B,
 * OD-07 A, OD-08 A.
 *
 * Guarantees, each proved in `test/payroll.e2e.test.ts`:
 *
 *   - **Generation is all-or-nothing** (rule 3). Pre-flight runs inside the
 *     one transaction that creates the period and every line. A missing
 *     salary, a broken schedule or a net that would go negative blocks
 *     everything and lists the employees (422). Incomplete attendance is a
 *     409 listing employees and dates, unless the Admin proceeds knowingly.
 *     Any failure writes nothing. Period totals are the exact sums of the
 *     lines.
 *   - **One period per company per month** (rule 4): the unique constraint,
 *     plus `Idempotency-Key` replay. A concurrent second request never
 *     creates a second period.
 *   - **The state machine** is `payroll-rules.ts`, re-checked under a
 *     `FOR UPDATE` lock on the period, so two concurrent finalizations give
 *     one success and one 409.
 *   - **Finalization** (rule 11) needs the typed `YYYY-MM`. One transaction
 *     writes each line's final snapshot, locks every line and the period.
 *     From then on the database itself refuses any change.
 *   - **Entries** (rule 6): append-only, with a reason and a creator, in an
 *     editable state only, re-netting the line and the period totals in the
 *     same transaction. A deduction that would take the net below zero is
 *     refused with the attempted figure (OD-06 B: never capped).
 *   - **Adjustments** (rule 2) are the only change after finalization. The
 *     original line is never touched; the outcome is derived. The period
 *     becomes `adjusted`. The adjusted outcome may not go below zero either.
 *   - **Audit after commit** through `AuditDispatcher`; events after that.
 *   - **Who** (OD-07 A): every write, and every company-wide read, needs a
 *     company scope (ADMIN). An EMPLOYEE reads only their own finalized
 *     payslips and estimate; anything else is 404. MANAGER has no payroll
 *     permission at all.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { compareDates, formatCalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import { IdempotencyService, isUniqueViolation } from '../common/idempotency.js';
import type { IdempotencyRequest } from '../common/idempotency.js';
import type { RequestOrigin } from '../common/request-context.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type {
  CreatePayrollAdjustmentDto,
  CreatePayrollEntryDto,
  GeneratePayrollDto,
  ListPayrollLinesQueryDto,
  ListPayrollPeriodsQueryDto,
  RecalculatePayrollDto,
} from './dto/payroll.dto.js';
import { renet } from './payroll-engine.js';
import { PayrollEventPublisher } from './payroll-events.js';
import type { PayrollEvent } from './payroll-events.js';
import {
  calculateMonth,
  companyToday,
  dateValue,
  eligibleEmployees,
  loadPolicy,
  moneyString,
  monthWindow,
  snapshotExact,
} from './payroll-inputs.js';
import type {
  Blocked,
  EmployeeCalculation,
  MonthCalculation,
  MonthWindow,
} from './payroll-inputs.js';
import {
  entryPayload,
  LINE_SELECT,
  lineSummary,
  PERIOD_SELECT,
  payslipPayload,
  periodPayload,
} from './payroll-payload.js';
import type {
  LineSummaryPayload,
  PayrollPermissions,
  PayslipPayload,
  PeriodPayload,
} from './payroll-payload.js';
import {
  assertAllowed,
  forbidden,
  LOCKED_STATUSES,
  nextStatus,
  payrollReach,
  periodLabel,
  requireCompany,
} from './payroll-rules.js';
import type { PeriodAction, PeriodStatus } from './payroll-rules.js';

export interface PeriodList {
  readonly items: readonly PeriodPayload[];
  readonly total: number;
}

export interface PeriodDetail extends PeriodPayload {
  readonly lines: readonly LineSummaryPayload[];
}

export interface PreflightEmployee {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface Preflight {
  readonly label: string;
  readonly policy_configured: boolean;
  readonly month_ended: boolean;
  readonly existing_period: { readonly id: string; readonly status: string } | null;
  readonly employee_count: number;
  readonly blocking: readonly {
    readonly employee: PreflightEmployee;
    readonly issue: string;
    readonly detail: string | null;
  }[];
  readonly warnings: readonly {
    readonly employee: PreflightEmployee;
    readonly pending_days: readonly string[];
    readonly missing_days: readonly string[];
    readonly unpriced_overtime_minutes: number;
    readonly zero_attendance: boolean;
  }[];
}

export interface PayrollEstimate {
  readonly label: string;
  /** DOCUMENT 15 rule 10: always provisional until the period is finalized. */
  readonly provisional: true;
  readonly available: boolean;
  /** Why there is no estimate: no salary, no policy, not employed this month. */
  readonly unavailable_reason: string | null;
  readonly currency: string | null;
  readonly monthly_salary: string | null;
  readonly estimated_net: string | null;
  readonly daily_wage: string | null;
  readonly working_days: number | null;
  readonly days_worked: number | null;
  readonly absent_days: number | null;
  readonly paid_leave_days: number | null;
  readonly unpaid_leave_days: number | null;
  readonly late_minutes_total: number | null;
  readonly attendance_adjustment: string | null;
}

type Kind = 'deduction' | 'bonus';

const ACTION_PERMISSION: Readonly<Record<PeriodAction, string>> = {
  recalculate: 'payroll.generate',
  submit_review: 'payroll.approve',
  approve: 'payroll.approve',
  return_to_draft: 'payroll.approve',
  return_to_review: 'payroll.approve',
  finalize: 'payroll.finalize',
  mark_paid: 'payroll.mark_paid',
  add_entry: 'payroll.add_deduction',
  adjust: 'payroll.adjust',
};

/**
 * DOCUMENT 21 names five state actions. Returning an approved run to review
 * is a resubmission for review, so it is recorded as
 * `payroll.submitted_for_review`, with the old and new status naming exactly
 * what happened. No action name is invented.
 */
const TRANSITION_AUDIT = {
  submit_review: 'PAYROLL_SUBMITTED_FOR_REVIEW',
  approve: 'PAYROLL_APPROVED',
  return_to_draft: 'PAYROLL_RETURNED_TO_DRAFT',
  return_to_review: 'PAYROLL_SUBMITTED_FOR_REVIEW',
} as const;

function sumMoney(values: readonly { toString(): string }[]): Decimal {
  return Decimal.sum(
    values.map((value) => Decimal.parse(moneyString(value), 2)),
    2,
  );
}

function employeeRef(employee: {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
}): PreflightEmployee {
  return {
    id: employee.id,
    code: employee.employeeCode,
    name: `${employee.firstName} ${employee.lastName}`,
  };
}

function lineData(calc: EmployeeCalculation) {
  const r = calc.result;
  return {
    baseSalary: r.baseSalary.toString(),
    dailyWage: r.dailyWage.toString(),
    workingDays: r.counts.workingDays,
    presentDays: r.counts.presentDays,
    wfhDays: r.counts.wfhDays,
    absentDays: r.counts.absentDays,
    paidLeaveDays: r.counts.paidLeaveDays,
    unpaidLeaveDays: r.counts.unpaidLeaveDays,
    lateMinutesTotal: r.counts.lateMinutes,
    attendanceAdjustment: r.attendanceAdjustment.toString(),
    totalDeductions: r.totalDeductions.toString(),
    totalBonuses: r.totalBonuses.toString(),
    netSalary: r.netSalary.toString(),
    status: (r.reviewReasons.length > 0 ? 'needs_review' : 'calculated') as
      | 'calculated'
      | 'needs_review',
    snapshot: calc.snapshot,
  };
}

@Injectable()
export class PayrollService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PayrollEventPublisher) private readonly events: PayrollEventPublisher,
  ) {
    super(prisma, audit);
  }

  // -- Reading ------------------------------------------------------------------

  private permissions(ctx: AuthContext): PayrollPermissions {
    const company = (key: string): boolean => ctx.permissions.get(key) === 'company';
    return {
      generate: company('payroll.generate'),
      approve: company('payroll.approve'),
      finalize: company('payroll.finalize'),
      markPaid: company('payroll.mark_paid'),
      deduct: company('payroll.add_deduction'),
      bonus: company('payroll.add_bonus'),
      adjust: company('payroll.adjust'),
    };
  }

  async listPeriods(ctx: AuthContext, query: ListPayrollPeriodsQueryDto): Promise<PeriodList> {
    requireCompany(ctx, 'payroll.view');
    const page = resolvePage(query);
    const where: Prisma.PayrollPeriodWhereInput =
      query.year === undefined ? {} : { year: query.year };
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.payrollPeriod.findMany({
          where,
          select: PERIOD_SELECT,
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.payrollPeriod.count({ where }),
      ]);
      const can = this.permissions(ctx);
      return { items: rows.map((row) => periodPayload(row, can)), total };
    });
  }

  async getPeriod(ctx: AuthContext, id: string): Promise<PeriodDetail> {
    requireCompany(ctx, 'payroll.view');
    return this.tenant(ctx, (tx) => this.detail(tx, ctx, id));
  }

  private async detail(tx: TenantClient, ctx: AuthContext, id: string): Promise<PeriodDetail> {
    const row = await tx.payrollPeriod.findFirst({ where: { id }, select: PERIOD_SELECT });
    if (row === null) throw notFound();
    const lines = await tx.payrollLine.findMany({
      where: { payrollPeriodId: id },
      select: LINE_SELECT,
      orderBy: [{ employee: { employeeCode: 'asc' } }, { id: 'asc' }],
    });
    return { ...periodPayload(row, this.permissions(ctx)), lines: lines.map(lineSummary) };
  }

  /** GET /payroll/lines/{id} — the payslip. Self: own, finalized only; anything else is 404. */
  async getLine(ctx: AuthContext, id: string): Promise<PayslipPayload> {
    const reach = payrollReach(ctx, 'payroll.view');
    return this.tenant(ctx, async (tx) => {
      const row = await tx.payrollLine.findFirst({
        where: {
          id,
          ...(reach.kind === 'self'
            ? {
                employeeId: reach.employeeId,
                period: { status: { in: [...LOCKED_STATUSES] } },
              }
            : {}),
        },
        select: LINE_SELECT,
      });
      if (row === null) throw notFound();
      return this.payslip(tx, ctx, row);
    });
  }

  private async payslip(
    tx: TenantClient,
    ctx: AuthContext,
    row: Prisma.PayrollLineGetPayload<{ select: typeof LINE_SELECT }>,
  ): Promise<PayslipPayload> {
    const [period, deductions, bonuses] = await Promise.all([
      tx.payrollPeriod.findUniqueOrThrow({
        where: { id: row.payrollPeriodId },
        select: PERIOD_SELECT,
      }),
      tx.payrollDeduction.findMany({
        where: { payrollLineId: row.id },
        include: { creator: { select: { id: true, email: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      tx.payrollBonus.findMany({
        where: { payrollLineId: row.id },
        include: { creator: { select: { id: true, email: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return payslipPayload(
      row,
      periodPayload(period, this.permissions(ctx)),
      deductions.map(entryPayload),
      bonuses.map(entryPayload),
    );
  }

  /** GET /payroll/lines — finalized payslips; an ADMIN may filter by employee, a self scope sees only their own. */
  async listLines(
    ctx: AuthContext,
    query: ListPayrollLinesQueryDto,
  ): Promise<{ readonly items: readonly LineSummaryPayload[]; readonly total: number }> {
    const reach = payrollReach(ctx, 'payroll.view');
    if (reach.kind === 'self') {
      if (query.employee_id !== undefined && query.employee_id !== reach.employeeId) {
        return { items: [], total: 0 };
      }
      return this.finalizedLines(ctx, reach.employeeId, query);
    }
    return this.finalizedLines(ctx, query.employee_id, query);
  }

  private async finalizedLines(
    ctx: AuthContext,
    employeeId: string | undefined,
    query: ListPayrollLinesQueryDto,
  ): Promise<{ readonly items: readonly LineSummaryPayload[]; readonly total: number }> {
    const page = resolvePage(query);
    const where: Prisma.PayrollLineWhereInput = {
      ...(employeeId === undefined ? {} : { employeeId }),
      period: { status: { in: [...LOCKED_STATUSES] } },
    };
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        tx.payrollLine.findMany({
          where,
          select: LINE_SELECT,
          orderBy: [{ period: { year: 'desc' } }, { period: { month: 'desc' } }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.payrollLine.count({ where }),
      ]);
      return { items: rows.map(lineSummary), total };
    });
  }

  // -- Pre-flight and generation ------------------------------------------------

  private async calculate(
    tx: TenantClient,
    window: MonthWindow,
    entries: ReadonlyMap<string, { deductions: string[]; bonuses: string[] }>,
    only?: readonly string[],
  ): Promise<MonthCalculation & { readonly employeeCount: number }> {
    const policy = await loadPolicy(tx);
    if (policy === null) {
      throw new AppException(ERROR_CODES.SALARY_POLICY_NOT_CONFIGURED, 422);
    }
    const employees = await eligibleEmployees(tx, window, only);
    const result = await calculateMonth(tx, policy, window, employees, entries);
    return { ...result, employeeCount: employees.length };
  }

  /** GET /payroll/periods/preflight — what generation would say, without generating. */
  async preflight(
    ctx: AuthContext,
    year: number,
    month: number,
    now: Date = new Date(),
  ): Promise<Preflight> {
    requireCompany(ctx, 'payroll.generate');
    const window = monthWindow(year, month);
    return this.tenant(ctx, async (tx) => {
      const today = await companyToday(tx, now);
      const existing = await tx.payrollPeriod.findFirst({
        where: { year, month },
        select: { id: true, status: true },
      });
      const policy = await loadPolicy(tx);
      const base = {
        label: periodLabel(year, month),
        policy_configured: policy !== null,
        month_ended: compareDates(today, window.end) > 0,
        existing_period: existing,
      };
      if (policy === null) {
        return { ...base, employee_count: 0, blocking: [], warnings: [] };
      }
      const result = await this.calculate(tx, window, new Map());
      return {
        ...base,
        employee_count: result.employeeCount,
        blocking: result.blocked.map((b) => ({
          employee: employeeRef(b.employee),
          issue: b.issue,
          detail: b.detail,
        })),
        warnings: this.warnings(result.calculations).map((w) => ({
          employee: employeeRef(w.employee),
          pending_days: w.result.counts.pendingDays,
          missing_days: w.result.counts.missingDays,
          unpriced_overtime_minutes: w.result.counts.unpricedOvertimeMinutes,
          zero_attendance: w.result.reviewReasons.includes('zero_attendance'),
        })),
      };
    });
  }

  private warnings(calculations: readonly EmployeeCalculation[]): EmployeeCalculation[] {
    return calculations.filter((c) => c.result.reviewReasons.length > 0);
  }

  /** 422 listing every blocked employee (DOCUMENT 15 rule 3, OD-06 B). */
  private assertNoneBlocked(blocked: readonly Blocked[]): void {
    if (blocked.length === 0) return;
    throw new AppException(ERROR_CODES.PAYROLL_PREFLIGHT_BLOCKED, 422, {
      fields: Object.fromEntries(
        blocked.map((b) => [
          b.employee.id,
          [b.detail === null ? b.issue : `${b.issue}:${b.detail}`],
        ]),
      ),
    });
  }

  /** 409 listing employees and dates, unless the Admin proceeds knowingly (DOCUMENT 15). */
  private assertWarningsAccepted(
    calculations: readonly EmployeeCalculation[],
    proceed: boolean | undefined,
  ): void {
    const flagged = this.warnings(calculations).filter(
      (c) => c.result.counts.pendingDays.length > 0 || c.result.counts.missingDays.length > 0,
    );
    if (flagged.length === 0 || proceed === true) return;
    throw new AppException(ERROR_CODES.PAYROLL_ATTENDANCE_INCOMPLETE, 409, {
      fields: Object.fromEntries(
        flagged.map((c) => [
          c.employee.id,
          [
            ...c.result.counts.pendingDays.map((d) => `pending:${d}`),
            ...c.result.counts.missingDays.map((d) => `missing:${d}`),
          ],
        ]),
      ),
    });
  }

  /** Totals as exact sums of the stored lines (DOCUMENT 15 "totals must equal the lines"). */
  private async writeTotals(tx: TenantClient, periodId: string) {
    const lines = await tx.payrollLine.findMany({
      where: { payrollPeriodId: periodId },
      select: {
        baseSalary: true,
        attendanceAdjustment: true,
        totalDeductions: true,
        totalBonuses: true,
        netSalary: true,
      },
    });
    const totals = {
      totalGross: sumMoney(lines.map((l) => l.baseSalary)).toString(),
      totalAttendanceAdjustment: sumMoney(lines.map((l) => l.attendanceAdjustment)).toString(),
      totalDeductions: sumMoney(lines.map((l) => l.totalDeductions)).toString(),
      totalBonuses: sumMoney(lines.map((l) => l.totalBonuses)).toString(),
      totalNet: sumMoney(lines.map((l) => l.netSalary)).toString(),
    };
    await tx.payrollPeriod.update({ where: { id: periodId }, data: totals });
    return totals;
  }

  private async lockPeriod(tx: TenantClient, id: string) {
    await tx.$queryRaw`SELECT id FROM payroll_periods WHERE id = ${id}::uuid FOR UPDATE`;
    const period = await tx.payrollPeriod.findFirst({ where: { id } });
    if (period === null) throw notFound();
    return period;
  }

  /** POST /payroll/periods — DOCUMENT 05 FLOW 14. */
  async generate(
    ctx: AuthContext,
    dto: GeneratePayrollDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<PeriodDetail> {
    requireCompany(ctx, 'payroll.generate');
    const window = monthWindow(dto.year, dto.month);
    const periodId = generateId();
    let created = false;
    let id = periodId;
    try {
      id = await this.tenant(ctx, async (tx) => {
        if (idempotency !== null) {
          const prior = await this.idempotency.replay(tx, ctx, idempotency, now);
          if (prior !== null) return prior;
          await this.idempotency.claim(tx, ctx, idempotency, periodId, now);
        }
        const today = await companyToday(tx, now);
        if (compareDates(today, window.end) <= 0) {
          throw new AppException(ERROR_CODES.PAYROLL_PERIOD_NOT_ENDED, 422);
        }
        const existing = await tx.payrollPeriod.findFirst({
          where: { year: dto.year, month: dto.month },
          select: { id: true, status: true },
        });
        if (existing !== null) {
          throw new AppException(ERROR_CODES.PAYROLL_PERIOD_EXISTS, 409, {
            fields: { period_id: [existing.id], status: [existing.status] },
          });
        }

        const result = await this.calculate(tx, window, new Map());
        this.assertNoneBlocked(result.blocked);
        this.assertWarningsAccepted(result.calculations, dto.proceed_with_warnings);

        await tx.payrollPeriod.create({
          data: {
            id: periodId,
            companyId: ctx.companyId,
            year: dto.year,
            month: dto.month,
            startDate: dateValue(window.start),
            endDate: dateValue(window.end),
            status: 'draft',
            generatedBy: ctx.userId,
            generatedAt: now,
          },
        });
        for (const calc of result.calculations) {
          await tx.payrollLine.create({
            data: {
              id: generateId(),
              payrollPeriodId: periodId,
              companyId: ctx.companyId,
              employeeId: calc.employee.id,
              ...lineData(calc),
            },
          });
        }
        const totals = await this.writeTotals(tx, periodId);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'PAYROLL_GENERATED',
          entityType: 'payroll_period',
          entityId: periodId,
          newValues: {
            period: periodLabel(dto.year, dto.month),
            status: 'draft',
            employee_count: result.calculations.length,
            total_gross: totals.totalGross,
            total_net: totals.totalNet,
            proceeded_with_warnings: dto.proceed_with_warnings === true,
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        created = true;
        return periodId;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (idempotency !== null) {
        const prior = await this.tenant(ctx, (tx) =>
          this.idempotency.replay(tx, ctx, idempotency, now),
        );
        if (prior !== null) return this.getPeriod(ctx, prior);
      }
      // Two generations raced without a shared key: the unique constraint
      // let exactly one through (DOCUMENT 15 "generated twice concurrently").
      throw new AppException(ERROR_CODES.PAYROLL_PERIOD_EXISTS, 409);
    }
    if (created) await this.publish('payroll_generated', ctx.companyId, id, null, now);
    return this.getPeriod(ctx, id);
  }

  /** POST /payroll/periods/{id}/recalculate — draft only (rule 5). Entries are kept. */
  async recalculate(
    ctx: AuthContext,
    id: string,
    dto: RecalculatePayrollDto,
    origin: RequestOrigin,
  ): Promise<PeriodDetail> {
    requireCompany(ctx, 'payroll.generate');
    await this.tenant(ctx, async (tx) => {
      const period = await this.lockPeriod(tx, id);
      assertAllowed('recalculate', period.status as PeriodStatus);
      const window = monthWindow(period.year, period.month);
      const lines = await tx.payrollLine.findMany({
        where: { payrollPeriodId: id },
        select: {
          id: true,
          employeeId: true,
          netSalary: true,
          deductions: { select: { amount: true } },
          bonuses: { select: { amount: true } },
        },
      });
      const entries = new Map(
        lines.map((line) => [
          line.employeeId,
          {
            deductions: line.deductions.map((d) => moneyString(d.amount)),
            bonuses: line.bonuses.map((b) => moneyString(b.amount)),
          },
        ]),
      );
      const result = await this.calculate(tx, window, entries);
      this.assertNoneBlocked(result.blocked);
      this.assertWarningsAccepted(result.calculations, dto.proceed_with_warnings);

      const before = {
        employee_count: lines.length,
        total_net: moneyString(period.totalNet),
      };
      const byEmployee = new Map(lines.map((line) => [line.employeeId, line]));
      const kept = new Set<string>();
      for (const calc of result.calculations) {
        const existing = byEmployee.get(calc.employee.id);
        if (existing === undefined) {
          await tx.payrollLine.create({
            data: {
              id: generateId(),
              payrollPeriodId: id,
              companyId: ctx.companyId,
              employeeId: calc.employee.id,
              ...lineData(calc),
            },
          });
        } else {
          kept.add(existing.id);
          await tx.payrollLine.update({ where: { id: existing.id }, data: lineData(calc) });
        }
      }
      // An employee no longer in the month: their draft line goes, unless the
      // Admin has entries on it, which are never discarded silently.
      for (const line of lines.filter((l) => !kept.has(l.id))) {
        if (line.deductions.length > 0 || line.bonuses.length > 0) {
          throw new AppException(ERROR_CODES.PAYROLL_PREFLIGHT_BLOCKED, 422, {
            fields: { [line.employeeId]: ['no_longer_eligible_with_entries'] },
          });
        }
        await tx.payrollLine.delete({ where: { id: line.id } });
      }
      const totals = await this.writeTotals(tx, id);
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PAYROLL_REGENERATED',
        entityType: 'payroll_period',
        entityId: id,
        oldValues: before,
        newValues: {
          employee_count: result.calculations.length,
          total_net: totals.totalNet,
          proceeded_with_warnings: dto.proceed_with_warnings === true,
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.getPeriod(ctx, id);
  }

  // -- The state machine ----------------------------------------------------------

  async transition(
    ctx: AuthContext,
    id: string,
    action: 'submit_review' | 'approve' | 'return_to_draft' | 'return_to_review',
    origin: RequestOrigin,
  ): Promise<PeriodDetail> {
    requireCompany(ctx, ACTION_PERMISSION[action]);
    await this.tenant(ctx, async (tx) => {
      const period = await this.lockPeriod(tx, id);
      const status = period.status as PeriodStatus;
      assertAllowed(action, status);
      const next = nextStatus(action, status);
      await tx.payrollPeriod.update({ where: { id }, data: { status: next } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: TRANSITION_AUDIT[action],
        entityType: 'payroll_period',
        entityId: id,
        oldValues: { status },
        newValues: { status: next },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    return this.getPeriod(ctx, id);
  }

  /** POST /payroll/periods/{id}/finalize — DOCUMENT 05 FLOW 16, rule 11. */
  async finalize(
    ctx: AuthContext,
    id: string,
    confirm: string,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<PeriodDetail> {
    requireCompany(ctx, 'payroll.finalize');
    await this.tenant(ctx, async (tx) => {
      const period = await this.lockPeriod(tx, id);
      const label = periodLabel(period.year, period.month);
      if (confirm !== label) {
        throw fieldError({ confirm: ['mismatch'] });
      }
      // Re-checked under the lock: of two concurrent finalizations, the second
      // finds the period already finalized (409).
      assertAllowed('finalize', period.status as PeriodStatus);

      const lines = await tx.payrollLine.findMany({
        where: { payrollPeriodId: id },
        select: {
          id: true,
          snapshot: true,
          baseSalary: true,
          attendanceAdjustment: true,
          totalDeductions: true,
          totalBonuses: true,
          netSalary: true,
          deductions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          bonuses: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });
      for (const line of lines) {
        const entry = (e: {
          id: string;
          type: string;
          amount: { toString(): string };
          reason: string;
          createdBy: string;
          createdAt: Date;
        }) => ({
          id: e.id,
          type: e.type,
          amount: moneyString(e.amount),
          reason: e.reason,
          created_by: e.createdBy,
          created_at: e.createdAt.toISOString(),
        });
        const exact = snapshotExact(line.snapshot);
        const net = renet({
          base: exact.base,
          attendanceAdjustment: exact.attendanceAdjustment,
          deductions: line.deductions.map((d) => moneyString(d.amount)),
          bonuses: line.bonuses.map((b) => moneyString(b.amount)),
          rounding: exact.rounding,
        });
        await tx.payrollLine.update({
          where: { id: line.id },
          data: {
            isLocked: true,
            snapshot: {
              ...(line.snapshot as Prisma.JsonObject),
              final: {
                period: label,
                finalized_at: now.toISOString(),
                finalized_by: ctx.userId,
                deductions: line.deductions.map(entry),
                bonuses: line.bonuses.map(entry),
                net_exact: net.net.toJSON(),
                figures: {
                  base_salary: moneyString(line.baseSalary),
                  attendance_adjustment: moneyString(line.attendanceAdjustment),
                  total_deductions: moneyString(line.totalDeductions),
                  total_bonuses: moneyString(line.totalBonuses),
                  net_salary: moneyString(line.netSalary),
                },
              },
            } as Prisma.InputJsonObject,
          },
        });
      }
      await tx.payrollPeriod.update({
        where: { id },
        data: { status: 'finalized', finalizedBy: ctx.userId, finalizedAt: now },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PAYROLL_FINALIZED',
        entityType: 'payroll_period',
        entityId: id,
        oldValues: { status: 'approved' },
        newValues: {
          status: 'finalized',
          period: label,
          employee_count: lines.length,
          total_net: moneyString(period.totalNet),
        },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    await this.publish('payroll_finalized', ctx.companyId, id, null, now);
    return this.getPeriod(ctx, id);
  }

  /** POST /payroll/periods/{id}/mark-paid — finalized → paid; an unpaid adjusted period keeps `adjusted`. */
  async markPaid(
    ctx: AuthContext,
    id: string,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<PeriodDetail> {
    requireCompany(ctx, 'payroll.mark_paid');
    await this.tenant(ctx, async (tx) => {
      const period = await this.lockPeriod(tx, id);
      const status = period.status as PeriodStatus;
      assertAllowed('mark_paid', status, period.paidAt);
      const next = nextStatus('mark_paid', status);
      await tx.payrollPeriod.update({ where: { id }, data: { status: next, paidAt: now } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PAYROLL_MARKED_PAID',
        entityType: 'payroll_period',
        entityId: id,
        oldValues: { status, paid_at: null },
        newValues: { status: next, paid_at: now.toISOString() },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
    await this.publish('payroll_marked_paid', ctx.companyId, id, null, now);
    return this.getPeriod(ctx, id);
  }

  // -- Deductions, bonuses and adjustments ----------------------------------------

  /** POST /payroll/lines/{id}/deductions and /bonuses — DOCUMENT 05 FLOW 15. */
  async addEntry(
    ctx: AuthContext,
    lineId: string,
    kind: Kind,
    dto: CreatePayrollEntryDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<PayslipPayload> {
    requireCompany(ctx, kind === 'deduction' ? 'payroll.add_deduction' : 'payroll.add_bonus');
    const entryId = generateId();
    let event: PayrollEvent | null = null;
    try {
      await this.tenant(ctx, async (tx) => {
        if (idempotency !== null) {
          if ((await this.idempotency.replay(tx, ctx, idempotency, now)) !== null) return;
          await this.idempotency.claim(tx, ctx, idempotency, entryId, now);
        }
        const found = await tx.payrollLine.findFirst({
          where: { id: lineId },
          select: { payrollPeriodId: true },
        });
        if (found === null) throw notFound();
        const period = await this.lockPeriod(tx, found.payrollPeriodId);
        const line = await tx.payrollLine.findUniqueOrThrow({
          where: { id: lineId },
          include: {
            deductions: { select: { amount: true } },
            bonuses: { select: { amount: true } },
          },
        });
        if (line.isLocked) throw new AppException(ERROR_CODES.PAYROLL_LINE_LOCKED, 409);
        assertAllowed('add_entry', period.status as PeriodStatus);

        const amount = Decimal.parse(dto.amount, 2).toString();
        const deductions = line.deductions.map((d) => moneyString(d.amount));
        const bonuses = line.bonuses.map((b) => moneyString(b.amount));
        if (kind === 'deduction') deductions.push(amount);
        else bonuses.push(amount);
        const exact = snapshotExact(line.snapshot);
        const result = renet({
          base: exact.base,
          attendanceAdjustment: exact.attendanceAdjustment,
          deductions,
          bonuses,
          rounding: exact.rounding,
        });
        if (result.negative) {
          // OD-06 B: refused, with the figure it would have produced.
          throw new AppException(ERROR_CODES.PAYROLL_NEGATIVE_NET, 422, {
            fields: { resulting_net: [result.net.toDecimal(2, 'nearest').toString()] },
          });
        }
        const data = {
          id: entryId,
          payrollLineId: lineId,
          companyId: ctx.companyId,
          type: dto.type ?? 'other',
          amount,
          reason: dto.reason,
          createdBy: ctx.userId,
          createdAt: now,
        };
        if (kind === 'deduction') await tx.payrollDeduction.create({ data });
        else await tx.payrollBonus.create({ data });
        await tx.payrollLine.update({
          where: { id: lineId },
          data: {
            totalDeductions: result.totalDeductions.toString(),
            totalBonuses: result.totalBonuses.toString(),
            netSalary: result.netSalary.toString(),
          },
        });
        await this.writeTotals(tx, period.id);
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: kind === 'deduction' ? 'DEDUCTION_ADDED' : 'BONUS_ADDED',
          entityType: 'payroll_line',
          entityId: lineId,
          oldValues: { net_salary: moneyString(line.netSalary) },
          newValues: {
            [`${kind}_id`]: entryId,
            employee_id: line.employeeId,
            type: data.type,
            amount,
            reason: dto.reason,
            net_salary: result.netSalary.toString(),
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        event = {
          type: kind === 'deduction' ? 'payroll_deduction_added' : 'payroll_bonus_added',
          companyId: ctx.companyId,
          periodId: period.id,
          employeeId: line.employeeId,
          occurredAt: now,
        };
      });
    } catch (error) {
      if (!(idempotency !== null && isUniqueViolation(error))) throw error;
      const prior = await this.tenant(ctx, (tx) =>
        this.idempotency.replay(tx, ctx, idempotency, now),
      );
      if (prior === null) throw error;
    }
    if (event !== null) await this.events.publish(event);
    return this.getLine(ctx, lineId);
  }

  /** POST /payroll/lines/{id}/adjustments — rule 2: the original line is never touched. */
  async adjust(
    ctx: AuthContext,
    lineId: string,
    dto: CreatePayrollAdjustmentDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<PayslipPayload> {
    requireCompany(ctx, 'payroll.adjust');
    const adjustmentId = generateId();
    let event: PayrollEvent | null = null;
    try {
      await this.tenant(ctx, async (tx) => {
        if (idempotency !== null) {
          if ((await this.idempotency.replay(tx, ctx, idempotency, now)) !== null) return;
          await this.idempotency.claim(tx, ctx, idempotency, adjustmentId, now);
        }
        const found = await tx.payrollLine.findFirst({
          where: { id: lineId },
          select: { payrollPeriodId: true },
        });
        if (found === null) throw notFound();
        const period = await this.lockPeriod(tx, found.payrollPeriodId);
        const status = period.status as PeriodStatus;
        assertAllowed('adjust', status);
        const line = await tx.payrollLine.findUniqueOrThrow({
          where: { id: lineId },
          include: { adjustments: { select: { amount: true } } },
        });

        const amount = Decimal.parse(dto.amount, 2);
        const outcome = Decimal.parse(moneyString(line.netSalary), 2)
          .add(sumMoney(line.adjustments.map((a) => a.amount)))
          .add(amount);
        if (outcome.isNegative()) {
          throw new AppException(ERROR_CODES.PAYROLL_NEGATIVE_NET, 422, {
            fields: { resulting_net: [outcome.toString()] },
          });
        }
        await tx.payrollAdjustment.create({
          data: {
            id: adjustmentId,
            originalPayrollLineId: lineId,
            companyId: ctx.companyId,
            employeeId: line.employeeId,
            amount: amount.toString(),
            reason: dto.reason,
            createdBy: ctx.userId,
            createdAt: now,
          },
        });
        const next = nextStatus('adjust', status);
        if (next !== status) {
          await tx.payrollPeriod.update({ where: { id: period.id }, data: { status: next } });
        }
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'PAYROLL_ADJUSTMENT_CREATED',
          entityType: 'payroll_line',
          entityId: lineId,
          oldValues: { period_status: status },
          newValues: {
            adjustment_id: adjustmentId,
            employee_id: line.employeeId,
            amount: amount.toString(),
            reason: dto.reason,
            adjusted_net: outcome.toString(),
            period_status: next,
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        event = {
          type: 'payroll_adjustment_created',
          companyId: ctx.companyId,
          periodId: period.id,
          employeeId: line.employeeId,
          occurredAt: now,
        };
      });
    } catch (error) {
      if (!(idempotency !== null && isUniqueViolation(error))) throw error;
      const prior = await this.tenant(ctx, (tx) =>
        this.idempotency.replay(tx, ctx, idempotency, now),
      );
      if (prior === null) throw error;
    }
    if (event !== null) await this.events.publish(event);
    return this.getLine(ctx, lineId);
  }

  // -- The employee's own view ------------------------------------------------------

  private ownEmployee(ctx: AuthContext): string {
    // Salary is shown only with a salary permission (OD-07 A): MANAGER has none.
    payrollReach(ctx, 'payroll.view');
    payrollReach(ctx, 'employee.view_salary');
    if (ctx.callerEmployeeId === null) throw forbidden();
    return ctx.callerEmployeeId;
  }

  /** GET /payroll/me — this month's provisional estimate (DOCUMENT 15 rule 10). */
  async me(ctx: AuthContext, now: Date = new Date()): Promise<PayrollEstimate> {
    const employeeId = this.ownEmployee(ctx);
    return this.tenant(ctx, async (tx) => {
      const today = await companyToday(tx, now);
      const window = monthWindow(today.year, today.month);
      const label = periodLabel(today.year, today.month);
      const company = await tx.company.findFirstOrThrow({ select: { currency: true } });
      const empty = (reason: string): PayrollEstimate => ({
        label,
        provisional: true,
        available: false,
        unavailable_reason: reason,
        currency: company.currency,
        monthly_salary: null,
        estimated_net: null,
        daily_wage: null,
        working_days: null,
        days_worked: null,
        absent_days: null,
        paid_leave_days: null,
        unpaid_leave_days: null,
        late_minutes_total: null,
        attendance_adjustment: null,
      });
      const policy = await loadPolicy(tx);
      if (policy === null) return empty('salary_policy_not_configured');
      const employees = await eligibleEmployees(tx, window, [employeeId]);
      if (employees.length === 0) return empty('not_employed_this_month');
      // Only days that have ended are judged: today is still in progress, so
      // it and every later day are projected as worked, never charged.
      const yesterday = new Date(Date.UTC(today.year, today.month - 1, today.day - 1));
      const result = await calculateMonth(tx, policy, window, employees, new Map(), {
        year: yesterday.getUTCFullYear(),
        month: yesterday.getUTCMonth() + 1,
        day: yesterday.getUTCDate(),
      });
      const calc = result.calculations[0];
      if (calc === undefined) {
        return empty(result.blocked[0]?.issue ?? 'unavailable');
      }
      const r = calc.result;
      const current = [...calc.result.segments]
        .reverse()
        .find((segment) => segment.from <= formatCalendarDate(today));
      return {
        label,
        provisional: true,
        available: true,
        unavailable_reason: null,
        currency: company.currency,
        monthly_salary: (current ?? r.segments[r.segments.length - 1])?.monthlySalary ?? null,
        estimated_net: r.netSalary.toString(),
        daily_wage: r.dailyWage.toString(),
        working_days: r.counts.workingDays,
        days_worked: r.counts.presentDays + r.counts.wfhDays,
        absent_days: r.counts.absentDays,
        paid_leave_days: r.counts.paidLeaveDays,
        unpaid_leave_days: r.counts.unpaidLeaveDays,
        late_minutes_total: r.counts.lateMinutes,
        attendance_adjustment: r.attendanceAdjustment.toString(),
      };
    });
  }

  /** GET /payroll/me/history — own finalized payslips, newest first. */
  async myHistory(
    ctx: AuthContext,
    query: ListPayrollLinesQueryDto,
  ): Promise<{ readonly items: readonly LineSummaryPayload[]; readonly total: number }> {
    return this.finalizedLines(ctx, this.ownEmployee(ctx), query);
  }

  private async publish(
    type: PayrollEvent['type'],
    companyId: string,
    periodId: string,
    employeeId: string | null,
    occurredAt: Date,
  ): Promise<void> {
    await this.events.publish({ type, companyId, periodId, employeeId, occurredAt });
  }
}
