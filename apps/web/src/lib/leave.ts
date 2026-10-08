/**
 * Leave's screen rules — DOCUMENT 16, DOCUMENT 04 C1 (balance card), C9
 * (leave category), B13 (leave detail), B25 (leave types).
 *
 * Pure. The server counts the days (`GET /leave-requests/calculate`) and
 * decides every rule again; nothing here computes an authoritative figure.
 */

import type { Attachment } from './attachments';
import type { PersonRef } from './tasks';

export const CARRY_OVER_POLICIES = ['none', 'full', 'capped'] as const;
export type CarryOverPolicy = (typeof CARRY_OVER_POLICIES)[number];

export interface LeaveType {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_paid: boolean;
  readonly default_days_per_year: string;
  readonly requires_attachment: boolean;
  readonly allows_negative_balance: boolean;
  readonly carry_over_policy: CarryOverPolicy;
  readonly carry_over_cap: string | null;
  readonly is_active: boolean;
}

export interface LeaveTypeRef {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_paid: boolean;
}

export interface LeaveBalance {
  readonly id: string;
  readonly employee: {
    readonly id: string;
    readonly first_name: string;
    readonly last_name: string;
  };
  readonly leave_type: LeaveTypeRef;
  readonly year: number;
  readonly total_days: string;
  readonly used_days: string;
  readonly pending_days: string;
  readonly carried_over_days: string;
  readonly remaining_days: string;
}

export interface LeaveRequest {
  readonly id: string;
  readonly employee: {
    readonly id: string;
    readonly first_name: string;
    readonly last_name: string;
  };
  readonly leave_type: LeaveTypeRef;
  readonly start_date: string;
  readonly end_date: string;
  readonly days_count: string;
  readonly year_allocation: Record<string, string>;
  readonly reason: string;
  readonly attachment: Attachment | null;
  readonly status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  readonly reviewed_by: PersonRef | null;
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  readonly is_own: boolean;
  readonly abilities: {
    readonly can_review: boolean;
    readonly can_cancel: boolean;
    readonly can_cancel_approved: boolean;
  };
  readonly balances: readonly LeaveBalance[];
  readonly holidays_inside: readonly string[];
}

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
  readonly balance_impact: readonly {
    readonly year: number;
    readonly days: string;
    readonly remaining_before: string;
    readonly remaining_after: string;
  }[];
  readonly excess_days: string;
  readonly sufficient: boolean;
}

/** The type's name in the reader's language. */
export function typeName(type: Pick<LeaveTypeRef, 'name_ar' | 'name_en'>, locale: string): string {
  return locale === 'ar' ? type.name_ar : type.name_en;
}

/** A two-place day string as a person reads it: "3", "11.67", "-1". */
export function formatDays(value: string): string {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole ?? '0'}${trimmed === '' ? '' : `.${trimmed}`}`;
}

export function isNegative(value: string): boolean {
  return value.startsWith('-') && formatDays(value) !== '-0';
}

/** The `/leave-requests/calculate` query, or null until both dates are chosen. */
export function calculateQuery(form: {
  readonly leave_type_id: string;
  readonly start_date: string;
  readonly end_date: string;
}): Record<string, string> | null {
  if (form.start_date === '' || form.end_date === '') return null;
  return {
    start_date: form.start_date,
    end_date: form.end_date,
    ...(form.leave_type_id === '' ? {} : { leave_type_id: form.leave_type_id }),
  };
}

// ---------------------------------------------------------------------------
// The leave form — DOCUMENT 04 C9, FLOW 07
// ---------------------------------------------------------------------------

export interface LeaveForm {
  leave_type_id: string;
  start_date: string;
  end_date: string;
  reason: string;
}

export const EMPTY_LEAVE_FORM: LeaveForm = {
  leave_type_id: '',
  start_date: '',
  end_date: '',
  reason: '',
};

/** DOCUMENT 16 "Validation" — reason at least 3 characters. */
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 1000;

/** Hints before submitting, as translation keys by field; the API decides. */
export function validateLeaveForm(
  form: LeaveForm,
  options: { readonly requiresAttachment: boolean; readonly hasFile: boolean },
): Record<string, string> {
  const issues: Record<string, string> = {};
  if (form.leave_type_id === '') issues['leave_type_id'] = 'validation.required';
  if (form.start_date === '') issues['start_date'] = 'validation.required';
  if (form.end_date === '') issues['end_date'] = 'validation.required';
  if (form.start_date !== '' && form.end_date !== '' && form.end_date < form.start_date) {
    issues['end_date'] = 'validation.end_before_start';
  }
  if (form.reason.trim().length < REASON_MIN_LENGTH)
    issues['reason'] = 'validation.reason_too_short';
  if (options.requiresAttachment && !options.hasFile) issues['file'] = 'validation.required';
  return issues;
}

/**
 * The submission body. With a file it is multipart (the API checks the file
 * with the request it belongs to); without one it is JSON. The day count is
 * never sent — the server calculates it.
 */
export function leaveSubmission(
  form: LeaveForm,
  file: File | null,
):
  | { readonly kind: 'json'; readonly body: Record<string, string> }
  | { readonly kind: 'form'; readonly body: FormData } {
  const fields = {
    leave_type_id: form.leave_type_id,
    start_date: form.start_date,
    end_date: form.end_date,
    reason: form.reason.trim(),
  };
  if (file === null) return { kind: 'json', body: fields };
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  body.append('file', file);
  return { kind: 'form', body };
}

// ---------------------------------------------------------------------------
// Leave types settings — DOCUMENT 04 B25
// ---------------------------------------------------------------------------

export interface LeaveTypeForm {
  name_ar: string;
  name_en: string;
  is_paid: boolean;
  default_days_per_year: string;
  requires_attachment: boolean;
  allows_negative_balance: boolean;
  carry_over_policy: CarryOverPolicy;
  carry_over_cap: string;
}

export const EMPTY_LEAVE_TYPE_FORM: LeaveTypeForm = {
  name_ar: '',
  name_en: '',
  is_paid: true,
  default_days_per_year: '0',
  requires_attachment: false,
  allows_negative_balance: false,
  carry_over_policy: 'none',
  carry_over_cap: '',
};

export function formFromLeaveType(type: LeaveType): LeaveTypeForm {
  return {
    name_ar: type.name_ar,
    name_en: type.name_en,
    is_paid: type.is_paid,
    default_days_per_year: formatDays(type.default_days_per_year),
    requires_attachment: type.requires_attachment,
    allows_negative_balance: type.allows_negative_balance,
    carry_over_policy: type.carry_over_policy,
    carry_over_cap: type.carry_over_cap === null ? '' : formatDays(type.carry_over_cap),
  };
}

const DAYS = /^\d{1,3}(\.\d{1,2})?$/;

export function validateLeaveTypeForm(form: LeaveTypeForm): Record<string, string> {
  const issues: Record<string, string> = {};
  if (form.name_ar.trim() === '') issues['name_ar'] = 'validation.required';
  if (form.name_en.trim() === '') issues['name_en'] = 'validation.required';
  if (!DAYS.test(form.default_days_per_year.trim()))
    issues['default_days_per_year'] = 'validation.invalid';
  if (form.carry_over_policy === 'capped' && !DAYS.test(form.carry_over_cap.trim())) {
    issues['carry_over_cap'] =
      form.carry_over_cap.trim() === '' ? 'validation.required' : 'validation.invalid';
  }
  return issues;
}

/** The body for POST / PATCH `/leave-types`. Decimals travel as strings. */
export function leaveTypeBody(form: LeaveTypeForm): Record<string, unknown> {
  return {
    name_ar: form.name_ar.trim(),
    name_en: form.name_en.trim(),
    is_paid: form.is_paid,
    default_days_per_year: form.default_days_per_year.trim(),
    requires_attachment: form.requires_attachment,
    allows_negative_balance: form.allows_negative_balance,
    carry_over_policy: form.carry_over_policy,
    carry_over_cap: form.carry_over_policy === 'capped' ? form.carry_over_cap.trim() : null,
  };
}

/**
 * B25 "warn before changes that affect future calculations": the allowance
 * and the carry-over rule shape balances written from now on; existing
 * balances and decided leave are not rewritten.
 */
export function affectsFutureCalculations(before: LeaveTypeForm, after: LeaveTypeForm): boolean {
  return (
    formatDays(before.default_days_per_year) !== formatDays(after.default_days_per_year) ||
    before.is_paid !== after.is_paid ||
    before.carry_over_policy !== after.carry_over_policy ||
    formatDays(before.carry_over_cap || '0') !== formatDays(after.carry_over_cap || '0') ||
    before.allows_negative_balance !== after.allows_negative_balance
  );
}

export function leaveTypesSettingsPath(locale: string): string {
  return `/${locale}/admin/settings/leave-types`;
}
