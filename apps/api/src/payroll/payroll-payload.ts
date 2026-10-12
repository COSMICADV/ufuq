/**
 * Payroll response shapes — DOCUMENT 08 §4.10, DOCUMENT 04 B/C payroll and
 * salary screens.
 *
 * Money is always a 2-place string. `abilities` says which actions the
 * period's state allows right now, from the same table the server enforces
 * (`payroll-rules.ts`), so a screen never offers an action the API refuses.
 */

import type { Prisma } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { Fraction } from './fraction.js';
import { shown } from './payroll-engine.js';
import { moneyString } from './payroll-inputs.js';
import { isAllowed, LOCKED_STATUSES, periodLabel } from './payroll-rules.js';
import type { PeriodStatus } from './payroll-rules.js';

export const PERIOD_SELECT = {
  id: true,
  year: true,
  month: true,
  startDate: true,
  endDate: true,
  status: true,
  generatedAt: true,
  finalizedAt: true,
  paidAt: true,
  totalGross: true,
  totalAttendanceAdjustment: true,
  totalDeductions: true,
  totalBonuses: true,
  totalNet: true,
  generator: { select: { id: true, email: true } },
  finalizer: { select: { id: true, email: true } },
  _count: { select: { lines: true } },
} as const;

export type PeriodRow = Prisma.PayrollPeriodGetPayload<{ select: typeof PERIOD_SELECT }>;

export interface PeriodAbilities {
  readonly can_recalculate: boolean;
  readonly can_submit_review: boolean;
  readonly can_approve: boolean;
  readonly can_return_to_draft: boolean;
  readonly can_return_to_review: boolean;
  readonly can_finalize: boolean;
  readonly can_mark_paid: boolean;
  readonly can_add_entries: boolean;
  readonly can_adjust: boolean;
}

export interface PeriodPayload {
  readonly id: string;
  readonly label: string;
  readonly year: number;
  readonly month: number;
  readonly start_date: string;
  readonly end_date: string;
  readonly status: PeriodStatus;
  readonly is_locked: boolean;
  readonly employee_count: number;
  readonly total_gross: string;
  readonly total_attendance_adjustment: string;
  readonly total_deductions: string;
  readonly total_bonuses: string;
  readonly total_net: string;
  readonly generated_at: string;
  readonly generated_by: { readonly id: string; readonly email: string };
  readonly finalized_at: string | null;
  readonly finalized_by: { readonly id: string; readonly email: string } | null;
  readonly paid_at: string | null;
  readonly abilities: PeriodAbilities;
}

/** The permissions a caller holds, for `abilities` — the state decides the rest. */
export interface PayrollPermissions {
  readonly generate: boolean;
  readonly approve: boolean;
  readonly finalize: boolean;
  readonly markPaid: boolean;
  readonly deduct: boolean;
  readonly bonus: boolean;
  readonly adjust: boolean;
}

function date(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function periodPayload(row: PeriodRow, can: PayrollPermissions): PeriodPayload {
  const status = row.status as PeriodStatus;
  return {
    id: row.id,
    label: periodLabel(row.year, row.month),
    year: row.year,
    month: row.month,
    start_date: date(row.startDate),
    end_date: date(row.endDate),
    status,
    is_locked: LOCKED_STATUSES.includes(status),
    employee_count: row._count.lines,
    total_gross: moneyString(row.totalGross),
    total_attendance_adjustment: moneyString(row.totalAttendanceAdjustment),
    total_deductions: moneyString(row.totalDeductions),
    total_bonuses: moneyString(row.totalBonuses),
    total_net: moneyString(row.totalNet),
    generated_at: row.generatedAt.toISOString(),
    generated_by: row.generator,
    finalized_at: row.finalizedAt?.toISOString() ?? null,
    finalized_by: row.finalizer,
    paid_at: row.paidAt?.toISOString() ?? null,
    abilities: {
      can_recalculate: can.generate && isAllowed('recalculate', status),
      can_submit_review: can.approve && isAllowed('submit_review', status),
      can_approve: can.approve && isAllowed('approve', status),
      can_return_to_draft: can.approve && isAllowed('return_to_draft', status),
      can_return_to_review: can.approve && isAllowed('return_to_review', status),
      can_finalize: can.finalize && isAllowed('finalize', status),
      can_mark_paid: can.markPaid && isAllowed('mark_paid', status, row.paidAt),
      can_add_entries: (can.deduct || can.bonus) && isAllowed('add_entry', status),
      can_adjust: can.adjust && isAllowed('adjust', status),
    },
  };
}

export const LINE_SELECT = {
  id: true,
  payrollPeriodId: true,
  employeeId: true,
  baseSalary: true,
  dailyWage: true,
  workingDays: true,
  presentDays: true,
  wfhDays: true,
  absentDays: true,
  paidLeaveDays: true,
  unpaidLeaveDays: true,
  lateMinutesTotal: true,
  attendanceAdjustment: true,
  totalDeductions: true,
  totalBonuses: true,
  netSalary: true,
  status: true,
  snapshot: true,
  isLocked: true,
  employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  period: { select: { year: true, month: true, status: true } },
  adjustments: {
    select: {
      id: true,
      amount: true,
      reason: true,
      createdAt: true,
      creator: { select: { id: true, email: true } },
    },
    // UUID v7 ids are time-ordered, so creation order is the id order too.
    orderBy: { createdAt: 'asc' },
  },
} as const;

export type LineRow = Prisma.PayrollLineGetPayload<{ select: typeof LINE_SELECT }>;

export interface EntryPayload {
  readonly id: string;
  readonly type: string;
  readonly amount: string;
  readonly reason: string;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface AdjustmentPayload {
  readonly id: string;
  readonly amount: string;
  readonly reason: string;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface LineSummaryPayload {
  readonly id: string;
  readonly period_id: string;
  /** `YYYY-MM`, with the parts and the period's state, so a payslip list can name its month. */
  readonly period_label: string;
  readonly period_year: number;
  readonly period_month: number;
  readonly period_status: PeriodStatus;
  readonly employee: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
  readonly base_salary: string;
  readonly daily_wage: string;
  readonly working_days: number;
  readonly present_days: number;
  readonly wfh_days: number;
  readonly absent_days: number;
  readonly paid_leave_days: number;
  readonly unpaid_leave_days: number;
  readonly late_minutes_total: number;
  readonly attendance_adjustment: string;
  readonly total_deductions: string;
  readonly total_bonuses: string;
  readonly net_salary: string;
  /** Sum of adjustments; the original `net_salary` never changes. */
  readonly adjustments_total: string;
  /** `net_salary` + adjustments — the derived outcome (DOCUMENT 15 rule 2). */
  readonly adjusted_net: string;
  readonly status: 'calculated' | 'needs_review';
  readonly review_reasons: readonly string[];
  readonly is_locked: boolean;
}

export interface PayslipBreakdown {
  readonly working_days_in_month: number;
  readonly calendar_days_in_month: number;
  readonly employed_from: string;
  readonly employed_to: string;
  readonly segments: readonly {
    readonly from: string;
    readonly to: string;
    readonly monthly_salary: string;
    readonly working_days: number;
    readonly base: string;
    readonly daily_wage: string;
  }[];
  readonly absence: string;
  readonly unpaid_leave: string;
  readonly lateness: string;
  readonly overtime: string;
  readonly late_incidents: number;
  readonly overtime_minutes: number;
  readonly unpriced_overtime_minutes: number;
  readonly pending_days: readonly string[];
  readonly missing_days: readonly string[];
  readonly policy: Prisma.JsonValue;
}

export interface PayslipPayload extends LineSummaryPayload {
  readonly period: PeriodPayload;
  readonly deductions: readonly EntryPayload[];
  readonly bonuses: readonly EntryPayload[];
  readonly adjustments: readonly AdjustmentPayload[];
  readonly breakdown: PayslipBreakdown;
  readonly can_add_entries: boolean;
  readonly can_adjust: boolean;
}

interface SnapshotShape {
  readonly review_reasons?: readonly string[];
  readonly working_days_in_month: number;
  readonly calendar_days_in_month: number;
  readonly employed_from: string;
  readonly employed_to: string;
  readonly segments: readonly {
    from: string;
    to: string;
    monthly_salary: string;
    working_days: number;
    base: string;
    daily_wage: string;
  }[];
  readonly exact: {
    absence: string;
    unpaid_leave: string;
    lateness: string;
    overtime: string;
  };
  readonly counts: {
    late_incidents: number;
    overtime_minutes: number;
    unpriced_overtime_minutes: number;
    pending_days: readonly string[];
    missing_days: readonly string[];
  };
  readonly policy: Prisma.JsonValue;
}

function adjustmentsTotal(row: LineRow): Decimal {
  return Decimal.sum(
    row.adjustments.map((adjustment) => Decimal.parse(moneyString(adjustment.amount), 2)),
    2,
  );
}

export function lineSummary(row: LineRow): LineSummaryPayload {
  const snapshot = row.snapshot as unknown as SnapshotShape;
  const adjustments = adjustmentsTotal(row);
  const net = Decimal.parse(moneyString(row.netSalary), 2);
  return {
    id: row.id,
    period_id: row.payrollPeriodId,
    period_label: periodLabel(row.period.year, row.period.month),
    period_year: row.period.year,
    period_month: row.period.month,
    period_status: row.period.status as PeriodStatus,
    employee: {
      id: row.employee.id,
      code: row.employee.employeeCode,
      name: `${row.employee.firstName} ${row.employee.lastName}`,
    },
    base_salary: moneyString(row.baseSalary),
    daily_wage: moneyString(row.dailyWage),
    working_days: row.workingDays,
    present_days: row.presentDays,
    wfh_days: row.wfhDays,
    absent_days: row.absentDays,
    paid_leave_days: row.paidLeaveDays,
    unpaid_leave_days: row.unpaidLeaveDays,
    late_minutes_total: row.lateMinutesTotal,
    attendance_adjustment: moneyString(row.attendanceAdjustment),
    total_deductions: moneyString(row.totalDeductions),
    total_bonuses: moneyString(row.totalBonuses),
    net_salary: net.toString(),
    adjustments_total: adjustments.toString(),
    adjusted_net: net.add(adjustments).toString(),
    status: row.status,
    review_reasons: snapshot.review_reasons ?? [],
    is_locked: row.isLocked,
  };
}

export function payslipPayload(
  row: LineRow,
  period: PeriodPayload,
  deductions: readonly EntryPayload[],
  bonuses: readonly EntryPayload[],
): PayslipPayload {
  const snapshot = row.snapshot as unknown as SnapshotShape;
  const amount = (value: string): string => shown(Fraction.fromJSON(value)).toString();
  return {
    ...lineSummary(row),
    period,
    deductions,
    bonuses,
    adjustments: row.adjustments.map((adjustment) => ({
      id: adjustment.id,
      amount: moneyString(adjustment.amount),
      reason: adjustment.reason,
      created_by: adjustment.creator,
      created_at: adjustment.createdAt.toISOString(),
    })),
    breakdown: {
      working_days_in_month: snapshot.working_days_in_month,
      calendar_days_in_month: snapshot.calendar_days_in_month,
      employed_from: snapshot.employed_from,
      employed_to: snapshot.employed_to,
      segments: snapshot.segments.map((segment) => ({
        from: segment.from,
        to: segment.to,
        monthly_salary: segment.monthly_salary,
        working_days: segment.working_days,
        base: amount(segment.base),
        daily_wage: amount(segment.daily_wage),
      })),
      absence: amount(snapshot.exact.absence),
      unpaid_leave: amount(snapshot.exact.unpaid_leave),
      lateness: amount(snapshot.exact.lateness),
      overtime: amount(snapshot.exact.overtime),
      late_incidents: snapshot.counts.late_incidents,
      overtime_minutes: snapshot.counts.overtime_minutes,
      unpriced_overtime_minutes: snapshot.counts.unpriced_overtime_minutes,
      pending_days: snapshot.counts.pending_days,
      missing_days: snapshot.counts.missing_days,
      policy: snapshot.policy,
    },
    can_add_entries: period.abilities.can_add_entries,
    can_adjust: period.abilities.can_adjust,
  };
}

export function entryPayload(row: {
  id: string;
  type: string;
  amount: { toString(): string };
  reason: string;
  createdAt: Date;
  creator: { id: string; email: string };
}): EntryPayload {
  return {
    id: row.id,
    type: row.type,
    amount: moneyString(row.amount),
    reason: row.reason,
    created_by: row.creator,
    created_at: row.createdAt.toISOString(),
  };
}
