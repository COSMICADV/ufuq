/**
 * Salary and payroll on the client — DOCUMENT 15, DOCUMENT 04 payroll and
 * salary screens, DOCUMENT 08 §4.10.
 *
 * Pure, so every rule here is unit-tested without a DOM:
 *
 *   - **No money arithmetic in the browser.** Every amount is a decimal string
 *     the server calculated, shown with its piastres (`formatMoney(…,
 *     { showDecimals: true })`: payroll never drops the fraction). A typed
 *     amount is only checked for shape. The server parses it exactly and does
 *     all the arithmetic.
 *   - **Finalization is not offered on a phone** (DOCUMENT 15 "Mobile
 *     behaviour"). `finalizationOffered` decides it from the period's
 *     abilities and the viewport. The server's state and permission checks
 *     stay authoritative either way.
 *   - Forms keep what was typed when the server refuses it (DOCUMENT 11 §2).
 */

import { formatMoney, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { ApiError } from './api-client';

// -- Shapes -----------------------------------------------------------------------

export const DAILY_WAGE_BASES = ['fixed_days', 'scheduled_working_days', 'calendar_days'] as const;
export type DailyWageBasis = (typeof DAILY_WAGE_BASES)[number];
export const UNPAID_LEAVE_RULES = ['daily_wage', 'scheduled_day_wage', 'none'] as const;
export type UnpaidLeaveRule = (typeof UNPAID_LEAVE_RULES)[number];
export const ABSENCE_RULES = ['daily_wage', 'none'] as const;
export type AbsenceRule = (typeof ABSENCE_RULES)[number];
export const ROUNDING_RULES = ['none', 'nearest', 'up', 'down'] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];
export const LATENESS_TYPES = ['none', 'per_minute', 'fixed_per_incident'] as const;
export type LatenessType = (typeof LATENESS_TYPES)[number];

export type LatenessRule =
  | { readonly type: 'none' }
  | { readonly type: 'per_minute'; readonly multiplier: string }
  | { readonly type: 'fixed_per_incident'; readonly amount: string };

export interface SalaryPolicy {
  readonly id: string;
  readonly name: string;
  readonly daily_wage_basis: DailyWageBasis;
  readonly fixed_days_value: number | null;
  readonly unpaid_leave_deduction: UnpaidLeaveRule;
  readonly absence_deduction: AbsenceRule;
  readonly lateness_rule: LatenessRule;
  readonly overtime_rate: string;
  readonly rounding: RoundingRule;
  readonly updated_at: string;
}

export interface SalaryRow {
  readonly id: string;
  readonly monthly_salary: string;
  readonly currency: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly note: string | null;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface EmployeeSalary {
  readonly employee_id: string;
  readonly current: SalaryRow | null;
  readonly history: readonly SalaryRow[];
}

export const PERIOD_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'finalized',
  'paid',
  'adjusted',
] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

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

export interface PayrollPeriod {
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
  readonly finalized_at: string | null;
  readonly paid_at: string | null;
  readonly abilities: PeriodAbilities;
}

export interface PayrollLine {
  readonly id: string;
  readonly period_id: string;
  readonly period_label: string;
  readonly period_year: number;
  readonly period_month: number;
  readonly period_status: PeriodStatus;
  readonly employee: { readonly id: string; readonly code: string; readonly name: string };
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
  readonly adjustments_total: string;
  readonly adjusted_net: string;
  readonly status: 'calculated' | 'needs_review';
  readonly review_reasons: readonly string[];
  readonly is_locked: boolean;
}

export interface PayrollPeriodDetail extends PayrollPeriod {
  readonly lines: readonly PayrollLine[];
}

export interface PayrollEntry {
  readonly id: string;
  readonly type?: string;
  readonly amount: string;
  readonly reason: string;
  readonly created_by: { readonly id: string; readonly email: string };
  readonly created_at: string;
}

export interface Payslip extends PayrollLine {
  readonly period: PayrollPeriod;
  readonly deductions: readonly PayrollEntry[];
  readonly bonuses: readonly PayrollEntry[];
  readonly adjustments: readonly PayrollEntry[];
  readonly breakdown: {
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
  };
  readonly can_add_entries: boolean;
  readonly can_adjust: boolean;
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
  readonly existing_period: { readonly id: string; readonly status: PeriodStatus } | null;
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
  readonly provisional: true;
  readonly available: boolean;
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

// -- Paths ------------------------------------------------------------------------

export function payrollPath(locale: string, periodId?: string, employeeId?: string): string {
  const base = `/${locale}/admin/payroll`;
  if (periodId === undefined) return base;
  return employeeId === undefined ? `${base}/${periodId}` : `${base}/${periodId}/${employeeId}`;
}

export function salaryPath(locale: string, segment?: 'history' | string): string {
  return segment === undefined ? `/${locale}/app/salary` : `/${locale}/app/salary/${segment}`;
}

// -- Display ------------------------------------------------------------------------

/** Money with its piastres, always — payroll never truncates (DOCUMENT 15). */
export function money(amount: string, currency: string, locale: Locale): string {
  return formatMoney(amount, currency, { locale, showDecimals: true });
}

export function isNegativeAmount(value: string): boolean {
  return value.startsWith('-') && /[1-9]/.test(value);
}

/** A positive amount shown as what it takes away: "666.67" → "-666.67"; zero stays "0.00". */
export function asDeduction(value: string): string {
  if (!/[1-9]/.test(value)) return value.replace(/^-/, '');
  return value.startsWith('-') ? value : `-${value}`;
}

export type StatusTone = 'info' | 'warning' | 'success' | 'danger' | 'cancelled';

export function statusTone(status: PeriodStatus): StatusTone {
  switch (status) {
    case 'draft':
      return 'info';
    case 'under_review':
      return 'warning';
    case 'approved':
      return 'info';
    case 'finalized':
    case 'paid':
      return 'success';
    case 'adjusted':
      return 'warning';
  }
}

/** The label a month list shows: "مارس 2026" / "March 2026", in the company calendar. */
export function monthLabel(year: number, month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
    numberingSystem: 'latn',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

// -- Finalization safety — DOCUMENT 15 rule 11, "Mobile behaviour" -------------------

/** DOCUMENT 22: tables become cards and the layout is "mobile" below 1024px. */
export const DESKTOP_MIN_WIDTH = 1024;

export function isDesktopWidth(width: number): boolean {
  return width >= DESKTOP_MIN_WIDTH;
}

/**
 * Whether the finalize action is rendered at all. On a phone or a narrow
 * tablet it is not offered — not hidden by CSS, simply not built — because an
 * irreversible financial action should not be one mis-tap away. Until the
 * viewport is known the answer is no.
 */
export function finalizationOffered(abilities: PeriodAbilities, desktop: boolean | null): boolean {
  return abilities.can_finalize && desktop === true;
}

/** The finalization confirmation must type the period exactly: `YYYY-MM`. */
export function confirmationMatches(typed: string, label: string): boolean {
  return normaliseDigits(typed.trim()) === label;
}

// -- Forms --------------------------------------------------------------------------

/** DECIMAL(15,2): up to thirteen integer digits, two decimals. Digits normalised. */
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;
const SIGNED_AMOUNT = /^-?\d{1,13}(\.\d{1,2})?$/;
const RATE = /^\d{1,3}(\.\d{1,2})?$/;

export function normaliseAmount(value: string): string {
  return normaliseDigits(value.trim());
}

function positive(value: string): boolean {
  return AMOUNT.test(value) && /[1-9]/.test(value);
}

export type Issues = Readonly<Record<string, string>>;

export interface PolicyForm {
  readonly name: string;
  readonly daily_wage_basis: DailyWageBasis | '';
  readonly fixed_days_value: string;
  readonly unpaid_leave_deduction: UnpaidLeaveRule | '';
  readonly absence_deduction: AbsenceRule | '';
  readonly lateness_type: LatenessType | '';
  readonly lateness_multiplier: string;
  readonly lateness_amount: string;
  readonly overtime_rate: string;
  readonly rounding: RoundingRule | '';
}

/** No default is invented (approved decision): a new policy starts empty. */
export const EMPTY_POLICY_FORM: PolicyForm = {
  name: '',
  daily_wage_basis: '',
  fixed_days_value: '',
  unpaid_leave_deduction: '',
  absence_deduction: '',
  lateness_type: '',
  lateness_multiplier: '',
  lateness_amount: '',
  overtime_rate: '',
  rounding: '',
};

export function formFromPolicy(policy: SalaryPolicy): PolicyForm {
  return {
    name: policy.name,
    daily_wage_basis: policy.daily_wage_basis,
    fixed_days_value: policy.fixed_days_value === null ? '' : String(policy.fixed_days_value),
    unpaid_leave_deduction: policy.unpaid_leave_deduction,
    absence_deduction: policy.absence_deduction,
    lateness_type: policy.lateness_rule.type,
    lateness_multiplier:
      policy.lateness_rule.type === 'per_minute' ? policy.lateness_rule.multiplier : '',
    lateness_amount:
      policy.lateness_rule.type === 'fixed_per_incident' ? policy.lateness_rule.amount : '',
    overtime_rate: policy.overtime_rate,
    rounding: policy.rounding,
  };
}

export function validatePolicyForm(form: PolicyForm): Issues {
  const issues: Record<string, string> = {};
  if (form.name.trim() === '') issues.name = 'validation.required';
  for (const key of [
    'daily_wage_basis',
    'unpaid_leave_deduction',
    'absence_deduction',
    'lateness_type',
    'rounding',
  ] as const) {
    if (form[key] === '')
      issues[key === 'lateness_type' ? 'lateness_rule' : key] = 'validation.required';
  }
  if (form.daily_wage_basis === 'fixed_days') {
    const days = normaliseAmount(form.fixed_days_value);
    if (
      !/^\d{1,2}$/.test(days) ||
      Number.parseInt(days, 10) < 1 ||
      Number.parseInt(days, 10) > 31
    ) {
      issues.fixed_days_value = 'payroll.issue_fixed_days';
    }
  }
  if (form.lateness_type === 'per_minute') {
    const value = normaliseAmount(form.lateness_multiplier);
    if (!RATE.test(value) || !/[1-9]/.test(value)) issues.lateness_rule = 'payroll.issue_rate';
  }
  if (
    form.lateness_type === 'fixed_per_incident' &&
    !positive(normaliseAmount(form.lateness_amount))
  ) {
    issues.lateness_rule = 'payroll.issue_amount';
  }
  if (!RATE.test(normaliseAmount(form.overtime_rate))) issues.overtime_rate = 'payroll.issue_rate';
  return issues;
}

export function policyBody(form: PolicyForm): Record<string, unknown> {
  const lateness: LatenessRule =
    form.lateness_type === 'per_minute'
      ? { type: 'per_minute', multiplier: normaliseAmount(form.lateness_multiplier) }
      : form.lateness_type === 'fixed_per_incident'
        ? { type: 'fixed_per_incident', amount: normaliseAmount(form.lateness_amount) }
        : { type: 'none' };
  return {
    name: form.name.trim(),
    daily_wage_basis: form.daily_wage_basis,
    fixed_days_value:
      form.daily_wage_basis === 'fixed_days'
        ? Number.parseInt(normaliseAmount(form.fixed_days_value), 10)
        : null,
    unpaid_leave_deduction: form.unpaid_leave_deduction,
    absence_deduction: form.absence_deduction,
    lateness_rule: lateness,
    overtime_rate: normaliseAmount(form.overtime_rate),
    rounding: form.rounding,
  };
}

export interface SalaryForm {
  readonly monthly_salary: string;
  readonly effective_from: string;
  readonly note: string;
}

export const EMPTY_SALARY_FORM: SalaryForm = { monthly_salary: '', effective_from: '', note: '' };

export function validateSalaryForm(form: SalaryForm): Issues {
  const issues: Record<string, string> = {};
  if (!positive(normaliseAmount(form.monthly_salary)))
    issues.monthly_salary = 'payroll.issue_amount';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.effective_from))
    issues.effective_from = 'validation.required';
  return issues;
}

export function salaryBody(form: SalaryForm): Record<string, unknown> {
  return {
    monthly_salary: normaliseAmount(form.monthly_salary),
    effective_from: form.effective_from,
    ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
  };
}

export interface EntryForm {
  readonly amount: string;
  readonly reason: string;
  readonly type: string;
}

export const EMPTY_ENTRY_FORM: EntryForm = { amount: '', reason: '', type: '' };

/** A deduction or bonus: amount > 0, a reason of at least 3 characters (DOCUMENT 15). */
export function validateEntryForm(form: EntryForm): Issues {
  const issues: Record<string, string> = {};
  if (!positive(normaliseAmount(form.amount))) issues.amount = 'payroll.issue_amount';
  if (form.reason.trim().length < 3) issues.reason = 'validation.reason_too_short';
  return issues;
}

/** An adjustment: a signed amount, never zero, with a reason. */
export function validateAdjustmentForm(form: Omit<EntryForm, 'type'>): Issues {
  const issues: Record<string, string> = {};
  const amount = normaliseAmount(form.amount);
  if (!SIGNED_AMOUNT.test(amount) || !/[1-9]/.test(amount))
    issues.amount = 'payroll.issue_signed_amount';
  if (form.reason.trim().length < 3) issues.reason = 'validation.reason_too_short';
  return issues;
}

export function entryBody(form: EntryForm): Record<string, unknown> {
  return {
    amount: normaliseAmount(form.amount),
    reason: form.reason.trim(),
    ...(form.type.trim() === '' ? {} : { type: form.type.trim() }),
  };
}

/**
 * A fresh `Idempotency-Key` per form submission, kept while the form is open
 * so a double click or a retry after a lost response replays instead of
 * creating twice (DOCUMENT 08 §8).
 */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

// -- The server's refusals, as sentences ----------------------------------------------

/** OD-06: the figure the refused deduction or adjustment would have produced. */
export function attemptedNet(error: ApiError): string | null {
  return error.fields.resulting_net?.[0] ?? null;
}

/**
 * A blocking or warning list from `POST /payroll/periods` (fields keyed by
 * employee id). Each entry becomes `{ employeeId, issue, detail }`.
 */
export function listedIssues(error: ApiError): readonly {
  readonly employeeId: string;
  readonly issue: string;
  readonly detail: string | null;
}[] {
  return Object.entries(error.fields).flatMap(([employeeId, issues]) =>
    issues.map((value) => {
      const [issue = value, ...rest] = value.split(':');
      return { employeeId, issue, detail: rest.length === 0 ? null : rest.join(':') };
    }),
  );
}

/** The translation key for a pre-flight issue. */
export function issueLabelKey(issue: string): string {
  switch (issue) {
    case 'salary_missing':
    case 'schedule_missing':
    case 'schedule_incomplete':
    case 'no_working_days_in_month':
    case 'negative_net':
    case 'no_longer_eligible_with_entries':
    case 'pending':
    case 'missing':
      return `payroll.issue.${issue}`;
    default:
      return 'payroll.issue.other';
  }
}

export const REVIEW_REASONS = [
  'zero_attendance',
  'pending_days',
  'missing_days',
  'unpriced_overtime',
] as const;
