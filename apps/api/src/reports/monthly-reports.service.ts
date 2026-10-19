/**
 * Monthly employee reports — DOCUMENT 18 "Employee reports" and rules 1–3,
 * DOCUMENT 05 FLOW 19, DOCUMENT 06 §3.27, DOCUMENT 08 §4.12 (amended).
 *
 * | Method | Path                                                         | Who                                         |
 * | ------ | ------------------------------------------------------------ | ------------------------------------------- |
 * | GET    | `/reports/employee/{id}/monthly?month=YYYY-MM`               | `report.employee_monthly` (company/team/self) |
 * | POST   | `/reports/employee/{id}/monthly/{year}/{month}/generate`     | the same scope — an employee for themselves |
 * | POST   | `/reports/employee/{id}/monthly/{year}/{month}/regenerate`   | company or team scope; never self           |
 * | GET    | `/employees/{id}/monthly-reports`                            | `report.employee_monthly` — the list        |
 *
 * **A snapshot.** A read returns what was saved; it is never recomputed into
 * the response. It is also compared — the content is recomputed from today's
 * sources and its fingerprint checked against the saved one — and
 * `underlying_data_changed` says whether they still agree. Nothing is
 * regenerated automatically.
 *
 * **Generation** of a missing snapshot is idempotent (a second request, or a
 * concurrent one, returns the first). **Regeneration** replaces an existing
 * snapshot explicitly: under a row lock, in one transaction (a failure leaves
 * the old snapshot whole), as the next revision — the database refuses any
 * other kind of update. Both are audited after commit
 * (`report.snapshot_generated`, `report.snapshot_regenerated`) and publish
 * `monthly_report_ready`.
 *
 * **Scope** (DOCUMENT 09 §4): another company's employee is a 404; an
 * employee in the tenant outside the caller's scope is a 403. An employee
 * may create their own missing report, never replace one.
 *
 * **Salary visibility** follows the salary module, not the report grant:
 * DOCUMENT 02 / OD-07 give a MANAGER no salary access, so a manager reading a
 * team member's report sees the salary section withheld; an employee sees
 * their own salary only from a finalized period (as their payslips), and an
 * ADMIN sees it all, provisional figures included.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { dateValue as calendarDateValue } from '../attendance/attendance-query.js';
import { calendarDateIn, compareDates, parseCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { employeeScopeWhere, forbidden } from '../employees/employee-query.js';
import { monthOf, PERFORMANCE_SUBJECT_SELECT } from '../performance/performance-month.js';
import type { Month, PerformanceSubject } from '../performance/performance-month.js';

import { isFinalPayroll } from './queries/payroll-report.js';
import { numeric } from './report-types.js';
import { ReportEventPublisher } from './report-events.js';
import type { ReportEvent } from './report-events.js';
import { snapshotContents } from './snapshot-content.js';
import type {
  AttendanceSummary,
  GoalSummary,
  SalarySummary,
  SnapshotContent,
  TaskSummary,
} from './snapshot-content.js';

export type SalaryView =
  | SalarySummary
  | { readonly withheld: 'no_permission' | 'not_finalized'; readonly is_provisional: boolean };

export interface MonthlyReportPayload {
  readonly id: string;
  readonly employee: {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly department_name_ar: string | null;
    readonly department_name_en: string | null;
  };
  readonly year: number;
  readonly month: number;
  readonly month_key: string;
  readonly generated_at: string;
  readonly revision: number;
  readonly is_provisional: boolean;
  /** The sources no longer give this content (DOCUMENT 18 rule 2). */
  readonly underlying_data_changed: boolean;
  readonly overall_score: string | null;
  readonly attendance: AttendanceSummary;
  readonly tasks: TaskSummary;
  readonly goals: GoalSummary;
  readonly salary: SalaryView;
  readonly performance: Prisma.JsonValue;
  readonly can_regenerate: boolean;
}

export interface MonthlyReportListItem {
  readonly id: string;
  readonly year: number;
  readonly month: number;
  readonly month_key: string;
  readonly generated_at: string;
  readonly revision: number;
  readonly is_provisional: boolean;
  readonly overall_score: string | null;
}

const EMPLOYEE_SELECT = {
  ...PERFORMANCE_SUBJECT_SELECT,
  firstName: true,
  lastName: true,
  employeeCode: true,
  department: { select: { nameAr: true, nameEn: true } },
} as const;

type EmployeeRow = PerformanceSubject & {
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeCode: string;
  readonly department: { readonly nameAr: string; readonly nameEn: string } | null;
};

type SnapshotRow = Prisma.MonthlyEmployeeReportGetPayload<object>;

/** DECIMAL(5,2) at its exact scale — `'100.00'`, never Prisma's `'100'`. */
function scoreOf(value: Prisma.Decimal | null): string | null {
  return value === null ? null : numeric(value, 2);
}

function monthKey(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** `YYYY-MM` → the month; the DTO has already checked the shape. */
export function parseMonthKey(value: string): Month {
  const first = parseCalendarDate(`${value}-01`);
  if (first === null) throw fieldError({ month: ['invalid'] });
  return monthOf(first.year, first.month);
}

/** Who may replace a snapshot: company or team scope, never self. */
function canRegenerate(ctx: AuthContext): boolean {
  const scope = ctx.permissions.get('report.employee_monthly');
  return scope === 'company' || scope === 'team' || scope === 'platform';
}

function salaryView(ctx: AuthContext, employeeId: string, salary: SalarySummary): SalaryView {
  const grant = ctx.permissions.get('employee.view_salary');
  if (grant === 'company' || grant === 'platform') return salary;
  if (grant === 'self' && ctx.callerEmployeeId === employeeId) {
    // As the payslips: an employee sees their own pay once it is final.
    return salary.source === 'payroll' &&
      salary.period_status !== null &&
      isFinalPayroll(salary.period_status)
      ? salary
      : { withheld: 'not_finalized', is_provisional: salary.is_provisional };
  }
  return { withheld: 'no_permission', is_provisional: salary.is_provisional };
}

function snapshotData(content: SnapshotContent): {
  attendanceSummary: Prisma.InputJsonObject;
  taskSummary: Prisma.InputJsonObject;
  goalSummary: Prisma.InputJsonObject;
  salarySummary: Prisma.InputJsonObject;
  performanceScores: Prisma.InputJsonObject;
  overallScore: string | null;
  isProvisional: boolean;
  sourceFingerprint: string;
} {
  return {
    attendanceSummary: content.attendance as unknown as Prisma.InputJsonObject,
    taskSummary: content.tasks as unknown as Prisma.InputJsonObject,
    goalSummary: content.goals as unknown as Prisma.InputJsonObject,
    salarySummary: content.salary as unknown as Prisma.InputJsonObject,
    performanceScores: content.performance as unknown as Prisma.InputJsonObject,
    overallScore: content.overall,
    isProvisional: content.provisional,
    sourceFingerprint: content.fingerprint,
  };
}

function auditSnapshot(row: SnapshotRow): Prisma.InputJsonObject {
  return {
    employee_id: row.employeeId,
    month: monthKey(row.year, row.month),
    revision: row.revision,
    is_provisional: row.isProvisional,
    overall_score: scoreOf(row.overallScore),
    source_fingerprint: row.sourceFingerprint,
  };
}

function readyEvent(row: SnapshotRow): ReportEvent {
  return {
    type: 'monthly_report_ready',
    companyId: row.companyId,
    employeeId: row.employeeId,
    reportId: row.id,
    year: row.year,
    month: row.month,
    occurredAt: new Date(),
  };
}

@Injectable()
export class MonthlyReportsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly dispatcher: AuditDispatcher,
    @Inject(ReportEventPublisher) private readonly events: ReportEventPublisher,
  ) {
    super(prisma, dispatcher);
  }

  // -- Reading ------------------------------------------------------------------

  async get(
    ctx: AuthContext,
    employeeId: string,
    month: Month,
    now: Date = new Date(),
  ): Promise<MonthlyReportPayload> {
    return this.tenant(ctx, async (tx) => {
      const employee = await this.reachable(tx, ctx, employeeId);
      const row = await tx.monthlyEmployeeReport.findUnique({
        where: {
          employeeId_year_month: {
            employeeId,
            year: month.first.year,
            month: month.first.month,
          },
        },
      });
      if (row === null) {
        throw new AppException(ERROR_CODES.REPORT_NOT_GENERATED, 404);
      }
      const { today, timeZone } = await this.clock(tx, now);
      const current = await snapshotContents(tx, [employee], month, today, timeZone);
      const fingerprint = (current.get(employee.id) as SnapshotContent).fingerprint;
      return this.payload(ctx, employee, row, fingerprint !== row.sourceFingerprint);
    });
  }

  async list(ctx: AuthContext, employeeId: string): Promise<readonly MonthlyReportListItem[]> {
    return this.tenant(ctx, async (tx) => {
      await this.reachable(tx, ctx, employeeId);
      const rows = await tx.monthlyEmployeeReport.findMany({
        where: { employeeId },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: {
          id: true,
          year: true,
          month: true,
          generatedAt: true,
          revision: true,
          isProvisional: true,
          overallScore: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        year: row.year,
        month: row.month,
        month_key: monthKey(row.year, row.month),
        generated_at: row.generatedAt.toISOString(),
        revision: row.revision,
        is_provisional: row.isProvisional,
        overall_score: scoreOf(row.overallScore),
      }));
    });
  }

  // -- Generating ---------------------------------------------------------------

  /** Create the missing snapshot, or return the existing one unchanged. */
  async generate(
    ctx: AuthContext,
    employeeId: string,
    year: number,
    monthNumber: number,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<{ readonly created: boolean; readonly report: MonthlyReportPayload }> {
    const month = monthOf(year, monthNumber);
    let created: SnapshotRow | null = null;
    try {
      created = await this.tenant(ctx, async (tx) => {
        const employee = await this.reachable(tx, ctx, employeeId);
        const { today, timeZone } = await this.clock(tx, now);
        assertGeneratable(employee, month, today);
        const existing = await findSnapshot(tx, employeeId, month);
        if (existing !== null) return null;
        const content = (await snapshotContents(tx, [employee], month, today, timeZone)).get(
          employee.id,
        ) as SnapshotContent;
        const row = await tx.monthlyEmployeeReport.create({
          data: {
            id: generateId(),
            companyId: ctx.companyId,
            employeeId,
            year: month.first.year,
            month: month.first.month,
            generatedAt: now,
            generatedBy: ctx.userId,
            ...snapshotData(content),
          },
        });
        await this.dispatcher.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'REPORT_SNAPSHOT_GENERATED',
          entityType: 'monthly_employee_report',
          entityId: row.id,
          newValues: auditSnapshot(row),
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return row;
      });
    } catch (error) {
      // A concurrent generation won the unique (employee, year, month): the
      // snapshot exists, which is what this request asked for.
      if (!isUniqueViolation(error)) throw error;
    }
    if (created !== null) {
      await this.events.publish([readyEvent(created)]);
    }
    return { created: created !== null, report: await this.get(ctx, employeeId, month, now) };
  }

  /** Replace an existing snapshot with one computed now — explicit, audited, atomic. */
  async regenerate(
    ctx: AuthContext,
    employeeId: string,
    year: number,
    monthNumber: number,
    origin: RequestOrigin,
    now: Date = new Date(),
  ): Promise<MonthlyReportPayload> {
    if (!canRegenerate(ctx)) {
      // DOCUMENT 18 rule 2 / approved policy: an employee may not replace a
      // historical snapshot, even their own.
      throw forbidden();
    }
    const month = monthOf(year, monthNumber);
    const updated = await this.tenant(ctx, async (tx) => {
      const employee = await this.reachable(tx, ctx, employeeId);
      const { today, timeZone } = await this.clock(tx, now);
      const existing = await findSnapshot(tx, employeeId, month);
      if (existing === null) {
        throw new AppException(ERROR_CODES.REPORT_NOT_GENERATED, 404);
      }
      // Serialise regenerations of one snapshot.
      await tx.$executeRaw`SELECT 1 FROM "monthly_employee_reports" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
      const locked = (await tx.monthlyEmployeeReport.findUnique({
        where: { id: existing.id },
      })) as SnapshotRow;
      const content = (await snapshotContents(tx, [employee], month, today, timeZone)).get(
        employee.id,
      ) as SnapshotContent;
      // The database requires a later generation time than the one replaced.
      const generatedAt =
        now.getTime() > locked.generatedAt.getTime()
          ? now
          : new Date(locked.generatedAt.getTime() + 1);
      const row = await tx.monthlyEmployeeReport.update({
        where: { id: locked.id },
        data: {
          ...snapshotData(content),
          generatedAt,
          generatedBy: ctx.userId,
          revision: locked.revision + 1,
        },
      });
      await this.dispatcher.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'REPORT_SNAPSHOT_REGENERATED',
        entityType: 'monthly_employee_report',
        entityId: row.id,
        oldValues: auditSnapshot(locked),
        newValues: auditSnapshot(row),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return row;
    });
    await this.events.publish([readyEvent(updated)]);
    return this.get(ctx, employeeId, month, now);
  }

  /**
   * The scheduled job's body for one company: every applicable employee's
   * missing snapshot for `month`, generated as the company's system actor.
   * Idempotent — an existing snapshot is never touched — and retry-safe.
   */
  async generateMissing(
    companyId: string,
    actorUserId: string,
    month: Month,
    now: Date = new Date(),
  ): Promise<number> {
    const rows = await this.dispatcher.withTenant(companyId, async (tx) => {
      const { today, timeZone } = await this.clock(tx, now);
      if (compareDates(month.last, today) >= 0) {
        return [];
      }
      const employees = await tx.employee.findMany({
        where: {
          deletedAt: null,
          // FLOW 19: the month's active employees. A deactivated account is
          // skipped; a termination inside the month still gets its last month.
          status: { not: 'inactive' },
          joiningDate: { lte: calendarDateValue(month.last) },
          OR: [
            { terminationDate: null },
            { terminationDate: { gte: calendarDateValue(month.first) } },
          ],
          monthlyReports: { none: { year: month.first.year, month: month.first.month } },
        },
        select: PERFORMANCE_SUBJECT_SELECT,
        orderBy: { id: 'asc' },
      });
      const contents = await snapshotContents(tx, employees, month, today, timeZone);
      const created: SnapshotRow[] = [];
      for (const employee of employees) {
        const row = await tx.monthlyEmployeeReport.create({
          data: {
            id: generateId(),
            companyId,
            employeeId: employee.id,
            year: month.first.year,
            month: month.first.month,
            generatedAt: now,
            generatedBy: actorUserId,
            ...snapshotData(contents.get(employee.id) as SnapshotContent),
          },
        });
        await this.dispatcher.record(tx, {
          companyId,
          userId: actorUserId,
          action: 'REPORT_SNAPSHOT_GENERATED',
          entityType: 'monthly_employee_report',
          entityId: row.id,
          newValues: { ...auditSnapshot(row), source: 'scheduled' },
        });
        created.push(row);
      }
      return created;
    });
    await this.events.publish(rows.map(readyEvent));
    return rows.length;
  }

  // -- Internals ----------------------------------------------------------------

  private async clock(
    tx: TenantClient,
    now: Date,
  ): Promise<{ readonly today: CalendarDate; readonly timeZone: string }> {
    const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
    return { today: calendarDateIn(now, company.timezone), timeZone: company.timezone };
  }

  /** 404 outside the tenant, 403 outside the caller's scope (DOCUMENT 09 §4). */
  private async reachable(
    tx: TenantClient,
    ctx: AuthContext,
    employeeId: string,
  ): Promise<EmployeeRow> {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId },
      select: EMPLOYEE_SELECT,
    });
    if (employee === null) {
      throw notFound();
    }
    const inScope = await tx.employee.findFirst({
      where: { AND: [{ id: employeeId }, employeeScopeWhere(ctx, 'report.employee_monthly')] },
      select: { id: true },
    });
    if (inScope === null) {
      throw forbidden();
    }
    return employee;
  }

  private payload(
    ctx: AuthContext,
    employee: EmployeeRow,
    row: SnapshotRow,
    changed: boolean,
  ): MonthlyReportPayload {
    return {
      id: row.id,
      employee: {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`,
        code: employee.employeeCode,
        department_name_ar: employee.department?.nameAr ?? null,
        department_name_en: employee.department?.nameEn ?? null,
      },
      year: row.year,
      month: row.month,
      month_key: monthKey(row.year, row.month),
      generated_at: row.generatedAt.toISOString(),
      revision: row.revision,
      is_provisional: row.isProvisional,
      underlying_data_changed: changed,
      overall_score: scoreOf(row.overallScore),
      attendance: row.attendanceSummary as unknown as AttendanceSummary,
      tasks: row.taskSummary as unknown as TaskSummary,
      goals: row.goalSummary as unknown as GoalSummary,
      salary: salaryView(ctx, employee.id, row.salarySummary as unknown as SalarySummary),
      performance: row.performanceScores,
      can_regenerate: canRegenerate(ctx),
    };
  }
}

async function findSnapshot(tx: TenantClient, employeeId: string, month: Month) {
  return tx.monthlyEmployeeReport.findUnique({
    where: {
      employeeId_year_month: { employeeId, year: month.first.year, month: month.first.month },
    },
  });
}

/** A snapshot is of a closed month in which the employee was employed. */
function assertGeneratable(employee: PerformanceSubject, month: Month, today: CalendarDate): void {
  if (compareDates(month.last, today) >= 0) {
    throw fieldError({ month: ['not_closed'] });
  }
  const joining = calendarDateIn(employee.joiningDate, 'UTC');
  if (compareDates(joining, month.last) > 0) {
    throw fieldError({ month: ['before_joining'] });
  }
  if (
    employee.terminationDate !== null &&
    compareDates(calendarDateIn(employee.terminationDate, 'UTC'), month.first) < 0
  ) {
    throw fieldError({ month: ['after_termination'] });
  }
}
