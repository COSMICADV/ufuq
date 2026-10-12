/**
 * Employee salary history — DOCUMENT 06 §3.21, DOCUMENT 08 §4.3
 * (`GET/POST /employees/{id}/salary`), DOCUMENT 15 rule 8, OD-07 A.
 *
 *   - **History, never rewritten.** A change closes the open row the day
 *     before the new one starts and inserts the new row. No amount is ever
 *     updated (and the database refuses it). A new row must start after the
 *     latest one: a past row is never re-cut, and a scheduled future row is
 *     never silently replaced.
 *   - **Not into a finalized month.** A change effective inside a finalized
 *     payroll period is refused (409 `PAYROLL_PERIOD_FINALIZED`). That pay
 *     is settled; the way forward is an adjustment.
 *   - **Only with a policy.** Each row names the company's salary policy;
 *     without one there is nothing to name (`SALARY_POLICY_NOT_CONFIGURED`).
 *   - **Who sees it.** `employee.view_salary`: ADMIN company, EMPLOYEE self,
 *     MANAGER nothing (OD-07 A). Another employee's salary is 404 to a self
 *     scope, exactly as another's payslip is (DOCUMENT 15).
 *   - Audited as `employee.salary_changed` after commit. `Idempotency-Key`
 *     replays a repeated change.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import {
  calendarDateIn,
  compareDates,
  formatCalendarDate,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import { IdempotencyService, isUniqueViolation } from '../common/idempotency.js';
import type { IdempotencyRequest } from '../common/idempotency.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type { SetSalaryDto } from './dto/payroll.dto.js';
import { companyToday, dateValue, loadPolicy, moneyString } from './payroll-inputs.js';
import { PayrollPeriodGuard } from './payroll-period-guard.js';
import { payrollReach, requireCompany } from './payroll-rules.js';

export interface SalaryRowPayload {
  readonly id: string;
  readonly monthly_salary: string;
  readonly currency: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly note: string | null;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface EmployeeSalaryPayload {
  readonly employee_id: string;
  /** The row in effect today, in the company's timezone. */
  readonly current: SalaryRowPayload | null;
  /** Every row, newest first. */
  readonly history: readonly SalaryRowPayload[];
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function previousDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day - 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

@Injectable()
export class EmployeeSalaryService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PayrollPeriodGuard) private readonly periods: PayrollPeriodGuard,
  ) {
    super(prisma, audit);
  }

  async get(
    ctx: AuthContext,
    employeeId: string,
    now: Date = new Date(),
  ): Promise<EmployeeSalaryPayload> {
    const reach = payrollReach(ctx, 'employee.view_salary');
    if (reach.kind === 'self' && reach.employeeId !== employeeId) {
      throw notFound();
    }
    return this.tenant(ctx, async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId },
        select: { id: true },
      });
      if (employee === null) throw notFound();
      const today = await companyToday(tx, now);
      const rows = await tx.employeeSalary.findMany({
        where: { employeeId },
        orderBy: { effectiveFrom: 'desc' },
        include: { creator: { select: { id: true, email: true } } },
      });
      const history = rows.map((row) => ({
        id: row.id,
        monthly_salary: moneyString(row.monthlySalary),
        currency: row.currency,
        effective_from: day(row.effectiveFrom),
        effective_to: row.effectiveTo === null ? null : day(row.effectiveTo),
        note: row.note,
        created_by: row.creator,
        created_at: row.createdAt.toISOString(),
      }));
      const todayKey = formatCalendarDate(today);
      const current =
        history.find(
          (row) =>
            row.effective_from <= todayKey &&
            (row.effective_to === null || row.effective_to >= todayKey),
        ) ?? null;
      return { employee_id: employeeId, current, history };
    });
  }

  async set(
    ctx: AuthContext,
    employeeId: string,
    dto: SetSalaryDto,
    idempotency: IdempotencyRequest | null,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<EmployeeSalaryPayload> {
    requireCompany(ctx, 'employee.set_salary');
    const rowId = generateId();
    try {
      await this.tenant(ctx, async (tx) => {
        if (idempotency !== null) {
          if ((await this.idempotency.replay(tx, ctx, idempotency, now)) !== null) return;
          await this.idempotency.claim(tx, ctx, idempotency, rowId, now);
        }
        const employee = await tx.employee.findFirst({
          where: { id: employeeId, deletedAt: null },
          select: { id: true, joiningDate: true, terminationDate: true },
        });
        if (employee === null) throw notFound();
        // One salary change at a time per employee.
        await tx.$queryRaw`SELECT id FROM employees WHERE id = ${employeeId}::uuid FOR UPDATE`;

        const policy = await loadPolicy(tx);
        if (policy === null) {
          throw new AppException(ERROR_CODES.SALARY_POLICY_NOT_CONFIGURED, 422);
        }
        const from = parseCalendarDate(dto.effective_from) as CalendarDate;
        if (compareDates(from, calendarDateIn(employee.joiningDate, 'UTC')) < 0) {
          throw fieldError({ effective_from: ['before_joining'] });
        }
        if (
          employee.terminationDate !== null &&
          compareDates(from, calendarDateIn(employee.terminationDate, 'UTC')) > 0
        ) {
          throw fieldError({ effective_from: ['after_termination'] });
        }
        // A settled month is not re-priced (DOCUMENT 15 rule 1).
        await this.periods.assertOpen(tx, [from]);

        const latest = await tx.employeeSalary.findFirst({
          where: { employeeId },
          orderBy: { effectiveFrom: 'desc' },
        });
        if (latest !== null) {
          if (compareDates(from, calendarDateIn(latest.effectiveFrom, 'UTC')) <= 0) {
            throw fieldError({ effective_from: ['not_after_current'] });
          }
          if (latest.effectiveTo === null) {
            await tx.employeeSalary.update({
              where: { id: latest.id },
              data: { effectiveTo: dateValue(previousDay(from)) },
            });
          }
        }
        const company = await tx.company.findFirstOrThrow({ select: { currency: true } });
        const amount = Decimal.parse(dto.monthly_salary, 2).toString();
        await tx.employeeSalary.create({
          data: {
            id: rowId,
            companyId: ctx.companyId,
            employeeId,
            monthlySalary: amount,
            currency: company.currency,
            effectiveFrom: dateValue(from),
            salaryPolicyId: policy.id,
            createdBy: ctx.userId,
            note: dto.note ?? null,
          },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'EMPLOYEE_SALARY_CHANGED',
          entityType: 'employee',
          entityId: employeeId,
          ...(latest === null
            ? {}
            : {
                oldValues: {
                  monthly_salary: moneyString(latest.monthlySalary),
                  effective_from: day(latest.effectiveFrom),
                },
              }),
          newValues: {
            monthly_salary: amount,
            effective_from: dto.effective_from,
            currency: company.currency,
            ...(dto.note === undefined ? {} : { note: dto.note }),
          },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      });
    } catch (error) {
      // A concurrent request with the same key committed first: replay it.
      if (!(idempotency !== null && isUniqueViolation(error))) throw error;
      const prior = await this.tenant(ctx, (tx) =>
        this.idempotency.replay(tx, ctx, idempotency, now),
      );
      if (prior === null) throw error;
    }
    return this.get(ctx, employeeId, now);
  }
}
