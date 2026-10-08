/**
 * The Requests Centre's fixed vocabulary and its OD-09 hybrid split —
 * DOCUMENT 01 FR-08, DOCUMENT 06 §3.20, OD-09.
 *
 * Pure: no database, no framework, so the rules are tested on their own.
 */

/** DOCUMENT 01 FR-08.1, in DOCUMENT 04 B13's tab order. */
export const REQUEST_CATEGORIES = ['attendance', 'leave', 'salary', 'task', 'general'] as const;
export type RequestCategoryValue = (typeof REQUEST_CATEGORIES)[number];

/** DOCUMENT 01 FR-08.3. */
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type RequestStatusValue = (typeof REQUEST_STATUSES)[number];

/**
 * OD-09 hybrid model: these categories live entirely in `requests`. Approving
 * one approves the request itself and changes nothing else — DOCUMENT 01
 * FR-08 gives them no business effect, so none is invented.
 */
export const NATIVE_CATEGORIES = ['salary', 'task', 'general'] as const;
export type NativeCategory = (typeof NATIVE_CATEGORIES)[number];

/**
 * …and these keep their specialised records, with `requests` as the inbox row
 * that points at them. The record is created through its own endpoint, and its
 * decisions run its own business rules.
 */
export const SPECIALISED_RELATED_TYPE = {
  attendance: 'attendance_correction_request',
  leave: 'leave_request',
} as const;

export function isNativeCategory(category: RequestCategoryValue): category is NativeCategory {
  return (NATIVE_CATEGORIES as readonly string[]).includes(category);
}

/** DOCUMENT 06 §3.20 `subject` VARCHAR(255). */
export const SUBJECT_MAX_LENGTH = 255;
/** The `requests_description_length` CHECK; the same bound as task descriptions. */
export const DESCRIPTION_MAX_LENGTH = 5000;
/** The `requests_admin_response_length` CHECK; the same bound as correction review notes. */
export const RESPONSE_MAX_LENGTH = 1000;

/**
 * Which decisions a request can still take. Only a pending request can be
 * decided or cancelled; approved, rejected and cancelled are terminal
 * (DOCUMENT 01 FR-08.3), so a repeated decision is refused, never re-applied.
 */
export function isOpen(status: RequestStatusValue): boolean {
  return status === 'pending';
}
