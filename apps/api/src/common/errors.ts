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
