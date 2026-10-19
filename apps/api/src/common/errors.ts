/**
 * Error codes and their bilingual messages — DOCUMENT 08 §2 and §3.
 *
 * DOCUMENT 27 RULE 25: both languages are always present. An error is not a
 * place where English quietly becomes the only option.
 *
 * The catalogue lives in @ufuq/i18n so error text is translated in the same
 * place as every other string. Only codes the application can actually raise
 * are listed; each phase adds the codes its endpoints introduce.
 */

import { createTranslator } from '@ufuq/i18n';

import type { ErrorBody } from './envelope.js';

export const ERROR_CODES = {
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Phase 3 — DOCUMENT 09, DOCUMENT 20 §1.
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_NOT_ACTIVATED: 'ACCOUNT_NOT_ACTIVATED',
  ACCOUNT_DEACTIVATED: 'ACCOUNT_DEACTIVATED',
  COMPANY_INACTIVE: 'COMPANY_INACTIVE',
  FORBIDDEN: 'FORBIDDEN',
  RATE_LIMITED: 'RATE_LIMITED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  PASSWORD_POLICY_VIOLATION: 'PASSWORD_POLICY_VIOLATION',
  // Phase 4 — DOCUMENT 08 §3's 409 "business conflict". `CONFLICT` is the
  // per-status fallback so a framework `ConflictException` can never surface
  // as INTERNAL_ERROR; the specific codes below are what a service raises
  // when it knows exactly which conflict this is (DOCUMENT 11 §11: say what
  // happened and what to do next, not "Failed").
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  CONFLICT: 'CONFLICT',
  DEPARTMENT_HAS_CHILDREN: 'DEPARTMENT_HAS_CHILDREN',
  DEPARTMENT_HAS_POSITIONS: 'DEPARTMENT_HAS_POSITIONS',
  // Phase 5 — employees. Each 409 names the state that blocks the action, so
  // the screen can say what to do next (DOCUMENT 05 FLOW 20 rule 4).
  DEPARTMENT_HAS_EMPLOYEES: 'DEPARTMENT_HAS_EMPLOYEES',
  EMPLOYEE_ALREADY_ACTIVE: 'EMPLOYEE_ALREADY_ACTIVE',
  EMPLOYEE_ALREADY_INACTIVE: 'EMPLOYEE_ALREADY_INACTIVE',
  EMPLOYEE_TERMINATED: 'EMPLOYEE_TERMINATED',
  EMPLOYEE_NOT_ACTIVE: 'EMPLOYEE_NOT_ACTIVE',
  ACCOUNT_ALREADY_ACTIVATED: 'ACCOUNT_ALREADY_ACTIVATED',
  // DOCUMENT 02 §7, DOCUMENT 09 §6: the last active ADMIN cannot be
  // deactivated or demoted.
  LAST_ACTIVE_ADMIN: 'LAST_ACTIVE_ADMIN',
  // 503: the invitation was issued but the mail relay refused it.
  MAIL_DELIVERY_FAILED: 'MAIL_DELIVERY_FAILED',
  // Phase 6 — attendance. DOCUMENT 12 "ERROR STATES": each says what blocked
  // the action and what to do instead, because on this screen the next step
  // is rarely "try again".
  ALREADY_CHECKED_IN: 'ALREADY_CHECKED_IN',
  NOT_CHECKED_IN: 'NOT_CHECKED_IN',
  ALREADY_CHECKED_OUT: 'ALREADY_CHECKED_OUT',
  NON_WORKING_DAY: 'NON_WORKING_DAY',
  CORRECTION_WINDOW_CLOSED: 'CORRECTION_WINDOW_CLOSED',
  CORRECTION_NOT_PENDING: 'CORRECTION_NOT_PENDING',
  CORRECTION_ALREADY_PENDING: 'CORRECTION_ALREADY_PENDING',
  ATTENDANCE_DATE_IN_FUTURE: 'ATTENDANCE_DATE_IN_FUTURE',
  // Phase 7 — tasks. DOCUMENT 13 "ERROR STATES": an invalid transition is a
  // 422 that explains the allowed transitions (they travel in `fields`), and
  // completing with open checklist items needs a confirmation naming the
  // count (DOCUMENT 13 rule 6) — a 409 the client answers by confirming.
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  TASK_HAS_OPEN_ITEMS: 'TASK_HAS_OPEN_ITEMS',
  // Phase 8 — goals. DOCUMENT 14 "Error states": a cancelled goal takes no
  // further changes (422), and a Task goal's value is derived from its tasks,
  // so a manual figure for one is refused (rule 4, "No manual entry").
  GOAL_CANCELLED: 'GOAL_CANCELLED',
  GOAL_PROGRESS_AUTOMATIC: 'GOAL_PROGRESS_AUTOMATIC',
  // Phase 9 — requests. A decided or cancelled request takes no further
  // decision (409); nobody reviews their own request (OD-03, 403); and the
  // specialised categories are submitted through their own records (OD-09
  // hybrid model, 422).
  REQUEST_NOT_PENDING: 'REQUEST_NOT_PENDING',
  REQUEST_SELF_REVIEW: 'REQUEST_SELF_REVIEW',
  REQUEST_CATEGORY_SPECIALISED: 'REQUEST_CATEGORY_SPECIALISED',
  // Phase 10 — leave (DOCUMENT 16 "Error states"). Conflicts that the request
  // cannot resolve by being sent again are 409; a range with nothing to take
  // or a balance that will not cover it is 422.
  LEAVE_NO_WORKING_DAYS: 'LEAVE_NO_WORKING_DAYS',
  LEAVE_INSUFFICIENT_BALANCE: 'LEAVE_INSUFFICIENT_BALANCE',
  LEAVE_OVERLAP: 'LEAVE_OVERLAP',
  LEAVE_ATTENDANCE_CONFLICT: 'LEAVE_ATTENDANCE_CONFLICT',
  LEAVE_NOT_PENDING: 'LEAVE_NOT_PENDING',
  LEAVE_RANGE_CHANGED: 'LEAVE_RANGE_CHANGED',
  LEAVE_PERIOD_FINALIZED: 'LEAVE_PERIOD_FINALIZED',
  // Phase 11 — payroll. DOCUMENT 15 "ERROR STATES"; each names the state that
  // blocks the action and the way forward (usually the adjustment flow).
  SALARY_POLICY_NOT_CONFIGURED: 'SALARY_POLICY_NOT_CONFIGURED',
  PAYROLL_PERIOD_EXISTS: 'PAYROLL_PERIOD_EXISTS',
  PAYROLL_PERIOD_NOT_ENDED: 'PAYROLL_PERIOD_NOT_ENDED',
  PAYROLL_PREFLIGHT_BLOCKED: 'PAYROLL_PREFLIGHT_BLOCKED',
  PAYROLL_ATTENDANCE_INCOMPLETE: 'PAYROLL_ATTENDANCE_INCOMPLETE',
  PAYROLL_INVALID_TRANSITION: 'PAYROLL_INVALID_TRANSITION',
  PAYROLL_PERIOD_FINALIZED: 'PAYROLL_PERIOD_FINALIZED',
  PAYROLL_LINE_LOCKED: 'PAYROLL_LINE_LOCKED',
  PAYROLL_NEGATIVE_NET: 'PAYROLL_NEGATIVE_NET',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  // Phase 13 — warehouse. DOCUMENT 17 "Error states" and "Edge cases".
  WAREHOUSE_HAS_STOCK: 'WAREHOUSE_HAS_STOCK',
  WAREHOUSE_INACTIVE: 'WAREHOUSE_INACTIVE',
  STOCK_INSUFFICIENT: 'STOCK_INSUFFICIENT',
  // Phase 14 — DOCUMENT 17 rule 5 / FLOW 18: negative stock is enabled but
  // the Admin has not acknowledged this movement's warning yet.
  STOCK_NEGATIVE_WARNING: 'STOCK_NEGATIVE_WARNING',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  REPORT_RANGE_CONFIRMATION_REQUIRED: 'REPORT_RANGE_CONFIRMATION_REQUIRED',
  REPORT_NOT_GENERATED: 'REPORT_NOT_GENERATED',
  REPORT_EXPORT_TOO_LARGE: 'REPORT_EXPORT_TOO_LARGE',
  REPORT_EXPORT_NOT_READY: 'REPORT_EXPORT_NOT_READY',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const MESSAGE_KEY_BY_CODE: Record<ErrorCode, string> = {
  DEPARTMENT_HAS_EMPLOYEES: 'error.department_has_employees',
  EMPLOYEE_ALREADY_ACTIVE: 'error.employee_already_active',
  EMPLOYEE_ALREADY_INACTIVE: 'error.employee_already_inactive',
  EMPLOYEE_TERMINATED: 'error.employee_terminated',
  EMPLOYEE_NOT_ACTIVE: 'error.employee_not_active',
  ACCOUNT_ALREADY_ACTIVATED: 'error.account_already_activated',
  LAST_ACTIVE_ADMIN: 'error.last_active_admin',
  MAIL_DELIVERY_FAILED: 'error.mail_delivery_failed',
  ALREADY_CHECKED_IN: 'error.already_checked_in',
  NOT_CHECKED_IN: 'error.not_checked_in',
  ALREADY_CHECKED_OUT: 'error.already_checked_out',
  NON_WORKING_DAY: 'error.non_working_day',
  CORRECTION_WINDOW_CLOSED: 'error.correction_window_closed',
  CORRECTION_NOT_PENDING: 'error.correction_not_pending',
  CORRECTION_ALREADY_PENDING: 'error.correction_already_pending',
  ATTENDANCE_DATE_IN_FUTURE: 'error.attendance_date_in_future',
  INVALID_STATUS_TRANSITION: 'error.invalid_status_transition',
  TASK_HAS_OPEN_ITEMS: 'error.task_has_open_items',
  GOAL_CANCELLED: 'error.goal_cancelled',
  GOAL_PROGRESS_AUTOMATIC: 'error.goal_progress_automatic',
  REQUEST_NOT_PENDING: 'error.request_not_pending',
  REQUEST_SELF_REVIEW: 'error.request_self_review',
  REQUEST_CATEGORY_SPECIALISED: 'error.request_category_specialised',
  LEAVE_NO_WORKING_DAYS: 'error.leave_no_working_days',
  LEAVE_INSUFFICIENT_BALANCE: 'error.leave_insufficient_balance',
  LEAVE_OVERLAP: 'error.leave_overlap',
  LEAVE_ATTENDANCE_CONFLICT: 'error.leave_attendance_conflict',
  LEAVE_NOT_PENDING: 'error.leave_not_pending',
  LEAVE_RANGE_CHANGED: 'error.leave_range_changed',
  LEAVE_PERIOD_FINALIZED: 'error.leave_period_finalized',
  SALARY_POLICY_NOT_CONFIGURED: 'error.salary_policy_not_configured',
  PAYROLL_PERIOD_EXISTS: 'error.payroll_period_exists',
  PAYROLL_PERIOD_NOT_ENDED: 'error.payroll_period_not_ended',
  PAYROLL_PREFLIGHT_BLOCKED: 'error.payroll_preflight_blocked',
  PAYROLL_ATTENDANCE_INCOMPLETE: 'error.payroll_attendance_incomplete',
  PAYROLL_INVALID_TRANSITION: 'error.payroll_invalid_transition',
  PAYROLL_PERIOD_FINALIZED: 'error.payroll_period_finalized',
  PAYROLL_LINE_LOCKED: 'error.payroll_line_locked',
  PAYROLL_NEGATIVE_NET: 'error.payroll_negative_net',
  IDEMPOTENCY_KEY_REUSED: 'error.idempotency_key_reused',
  WAREHOUSE_HAS_STOCK: 'error.warehouse_has_stock',
  WAREHOUSE_INACTIVE: 'error.warehouse_inactive',
  STOCK_INSUFFICIENT: 'error.stock_insufficient',
  STOCK_NEGATIVE_WARNING: 'error.stock_negative_warning',
  IDEMPOTENCY_KEY_REQUIRED: 'error.idempotency_key_required',
  REPORT_RANGE_CONFIRMATION_REQUIRED: 'error.report_range_confirmation_required',
  REPORT_NOT_GENERATED: 'error.report_not_generated',
  REPORT_EXPORT_TOO_LARGE: 'error.report_export_too_large',
  REPORT_EXPORT_NOT_READY: 'error.report_export_not_ready',
  NOT_FOUND: 'error.not_found',
  INTERNAL_ERROR: 'error.internal',
  VALIDATION_FAILED: 'error.validation_failed',
  UNAUTHENTICATED: 'error.unauthenticated',
  INVALID_CREDENTIALS: 'error.invalid_credentials',
  ACCOUNT_LOCKED: 'error.account_locked',
  ACCOUNT_NOT_ACTIVATED: 'error.account_not_activated',
  ACCOUNT_DEACTIVATED: 'error.account_deactivated',
  COMPANY_INACTIVE: 'error.company_inactive',
  FORBIDDEN: 'error.forbidden',
  RATE_LIMITED: 'error.rate_limited',
  TOKEN_INVALID: 'error.token_invalid',
  PASSWORD_POLICY_VIOLATION: 'error.password_policy_violation',
  MALFORMED_REQUEST: 'error.malformed_request',
  CONFLICT: 'error.conflict',
  DEPARTMENT_HAS_CHILDREN: 'error.department_has_children',
  DEPARTMENT_HAS_POSITIONS: 'error.department_has_positions',
};

const ar = createTranslator('ar');
const en = createTranslator('en');

/**
 * Build the error body for a code. `fields` is omitted rather than set to
 * undefined so the serialised response carries no empty key.
 */
export function errorBody(
  code: ErrorCode,
  fields?: Readonly<Record<string, readonly string[]>>,
): ErrorBody {
  const key = MESSAGE_KEY_BY_CODE[code];
  const base = {
    code,
    message_ar: ar(key),
    message_en: en(key),
  };
  return fields === undefined ? base : { ...base, fields };
}

const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  // DOCUMENT 08 §3, "Malformed request" — a path segment that is not a UUID,
  // for instance. Without this entry it would fall through to
  // INTERNAL_ERROR, which would both mislead the client and log a
  // well-formed refusal as a server fault.
  400: ERROR_CODES.MALFORMED_REQUEST,
  401: ERROR_CODES.UNAUTHENTICATED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  422: ERROR_CODES.VALIDATION_FAILED,
  429: ERROR_CODES.RATE_LIMITED,
};

/**
 * Map an HTTP status to its **default** error code — used for framework
 * exceptions (validation pipe failures, `NotFoundException`, …) that carry no
 * code of their own. A raised {@link AppException} always wins over this: it
 * names the specific code (there is more than one way to be a 401 — see
 * `ERROR_CODES` — and only the throw site knows which one this is).
 * Anything not explicitly mapped is an internal error, so an unrecognised
 * status can never leak a framework default page to the client
 * (DOCUMENT 08 §3).
 */
export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? ERROR_CODES.INTERNAL_ERROR;
}
