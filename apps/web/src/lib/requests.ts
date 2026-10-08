/**
 * The Requests Centre's screen rules — DOCUMENT 04 B13 / C8–C10, DOCUMENT 08
 * §4.9, OD-09.
 *
 * Pure, so the rules the screens follow are tested without a browser. The
 * API decides every permission again; nothing here grants anything.
 */

import type { PersonRef } from './tasks';
import type { CorrectionRequest } from './attendance';
import type { Attachment } from './attachments';

export const REQUEST_CATEGORIES = ['attendance', 'leave', 'salary', 'task', 'general'] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/**
 * The categories an employee submits through the Requests Centre's own form
 * (OD-09: they live in `requests`). Attendance is submitted as a correction,
 * from its own form; leave arrives with Phase 10.
 */
export const NATIVE_CATEGORIES = ['salary', 'task', 'general'] as const;
export type NativeCategory = (typeof NATIVE_CATEGORIES)[number];

/** The API's bounds (`request-rules.ts`), as hints; the API decides. */
export const SUBJECT_MAX_LENGTH = 255;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const RESPONSE_MAX_LENGTH = 1000;

/** `GET /requests` item — see `apps/api/src/requests/request-payload.ts`. */
export interface RequestItem {
  readonly id: string;
  readonly category: RequestCategory;
  readonly status: RequestStatus;
  readonly subject: string | null;
  readonly description: string | null;
  readonly employee: CorrectionRequest['employee'];
  readonly related_type: string | null;
  readonly related_id: string | null;
  readonly task: { readonly id: string; readonly title: string; readonly status: string } | null;
  readonly attendance: CorrectionRequest | null;
  readonly reviewed_by: PersonRef | null;
  readonly reviewed_at: string | null;
  readonly admin_response: string | null;
  readonly created_at: string;
  readonly is_own: boolean;
  readonly abilities: { readonly can_review: boolean; readonly can_cancel: boolean };
}

export interface RequestDetail extends RequestItem {
  readonly attachments: readonly Attachment[];
  readonly attachment_abilities: { readonly can_upload: boolean; readonly can_delete: boolean };
}

export interface PendingCount {
  readonly count: number;
  readonly basis: 'review' | 'own';
}

export function categoryKey(category: RequestCategory): string {
  return `requests.category.${category}`;
}

export function statusKey(status: RequestStatus): string {
  return `requests.status.${status}`;
}

/** Existing design-system tones only (DOCUMENT 27 RULE 22). */
export const STATUS_TONE: Readonly<
  Record<RequestStatus, 'warning' | 'success' | 'danger' | 'cancelled'>
> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'cancelled',
};

export function requesterName(item: Pick<RequestItem, 'employee'>): string {
  return `${item.employee.first_name} ${item.employee.last_name}`.trim();
}

/**
 * DOCUMENT 04 B13 "summary": a native request's subject; an attendance row's
 * summary is the day it corrects (the record it indexes has no subject).
 */
export function summaryOf(
  item: Pick<RequestItem, 'subject' | 'attendance'>,
):
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'attendance'; readonly date: string }
  | null {
  if (item.attendance !== null) {
    return { kind: 'attendance', date: item.attendance.date };
  }
  return item.subject === null ? null : { kind: 'text', text: item.subject };
}

/**
 * DOCUMENT 04 B13 "age indicator": whole days since submission, counted in
 * the company's calendar (never the browser's), so a request filed late
 * yesterday is one day old this morning.
 */
export function ageInDays(createdAt: string, timeZone: string, now: Date = new Date()): number {
  const day = (instant: Date): number => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day')) / 86_400_000;
  };
  return Math.max(0, day(now) - day(new Date(createdAt)));
}

// ---------------------------------------------------------------------------
// The admin dashboard — DOCUMENT 04 B1 widget 7
// ---------------------------------------------------------------------------

/** "Pending requests — 5 most recent". */
export const DASHBOARD_PENDING_LIMIT = 5;

/**
 * The widget's `GET /requests` query: pending, only what the caller may
 * decide (`reviewable`, which excludes their own — OD-03), newest first (the
 * API's order), five of them.
 */
export function pendingWidgetQuery(): Record<string, string> {
  return { status: 'pending', reviewable: 'true', per_page: String(DASHBOARD_PENDING_LIMIT) };
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function requestsPath(locale: string, surface: 'admin' | 'app' = 'admin'): string {
  return `/${locale}/${surface}/requests`;
}

export function requestPath(
  locale: string,
  id: string,
  surface: 'admin' | 'app' = 'admin',
): string {
  return `/${locale}/${surface}/requests/${id}`;
}

export function newRequestPath(locale: string): string {
  return `/${locale}/app/requests/new`;
}

/** Attendance is submitted as a correction, from DOCUMENT 04 C4's own form (OD-09). */
export function correctionFormPath(locale: string): string {
  return `/${locale}/app/attendance/correction/new`;
}

// ---------------------------------------------------------------------------
// The admin inbox's filters — held in the URL (DOCUMENT 11 §6)
// ---------------------------------------------------------------------------

/** The status filter's "every status" value; an absent status means Pending (B13). */
export const ALL_STATUSES = 'all';

export interface InboxFilters {
  /** '' is the "All" tab. */
  readonly category: RequestCategory | '';
  /** '' is every status; the default (no parameter) is Pending. */
  readonly status: RequestStatus | '';
  readonly employee: string;
  readonly from: string;
  readonly to: string;
  readonly page: number;
}

export const DEFAULT_INBOX_FILTERS: InboxFilters = {
  category: '',
  status: 'pending',
  employee: '',
  from: '',
  to: '',
  page: 1,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inboxFiltersFromParams(params: URLSearchParams): InboxFilters {
  const read = (key: string): string => params.get(key)?.trim() ?? '';
  const category = read('category');
  const status = read('status');
  const page = Number(read('page'));
  return {
    category: (REQUEST_CATEGORIES as readonly string[]).includes(category)
      ? (category as RequestCategory)
      : '',
    status:
      status === ALL_STATUSES
        ? ''
        : (REQUEST_STATUSES as readonly string[]).includes(status)
          ? (status as RequestStatus)
          : 'pending',
    employee: UUID.test(read('employee')) ? read('employee') : '',
    from: DATE.test(read('from')) ? read('from') : '',
    to: DATE.test(read('to')) ? read('to') : '',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function searchForInboxFilters(filters: InboxFilters): string {
  const params = new URLSearchParams();
  if (filters.category !== '') params.set('category', filters.category);
  if (filters.status === '') params.set('status', ALL_STATUSES);
  else if (filters.status !== 'pending') params.set('status', filters.status);
  if (filters.employee !== '') params.set('employee', filters.employee);
  if (filters.from !== '') params.set('from', filters.from);
  if (filters.to !== '') params.set('to', filters.to);
  if (filters.page > 1) params.set('page', String(filters.page));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export function apiQueryForInboxFilters(
  filters: InboxFilters,
  perPage: number,
): Record<string, string> {
  return {
    page: String(filters.page),
    per_page: String(perPage),
    ...(filters.category === '' ? {} : { category: filters.category }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.employee === '' ? {} : { employee_id: filters.employee }),
    ...(filters.from === '' ? {} : { from: filters.from }),
    ...(filters.to === '' ? {} : { to: filters.to }),
  };
}

/** Whether anything beyond the default (Pending, all categories) narrows the list. */
export function isNarrowed(filters: InboxFilters): boolean {
  return (
    filters.status !== 'pending' ||
    filters.employee !== '' ||
    filters.from !== '' ||
    filters.to !== ''
  );
}

// ---------------------------------------------------------------------------
// The submission form — DOCUMENT 04 C9
// ---------------------------------------------------------------------------

export interface RequestForm {
  category: NativeCategory;
  subject: string;
  description: string;
  task_id: string;
}

export const EMPTY_REQUEST_FORM: RequestForm = {
  category: 'general',
  subject: '',
  description: '',
  task_id: '',
};

/** Hints before submitting, as translation keys by field; the API decides. */
export function validateRequestForm(form: RequestForm): Record<string, string> {
  const issues: Record<string, string> = {};
  if (form.subject.trim() === '') issues['subject'] = 'validation.required';
  else if (form.subject.trim().length > SUBJECT_MAX_LENGTH)
    issues['subject'] = 'validation.too_long';
  if (form.description.trim() === '') issues['description'] = 'validation.required';
  else if (form.description.trim().length > DESCRIPTION_MAX_LENGTH) {
    issues['description'] = 'validation.too_long';
  }
  return issues;
}

/** The `POST /requests` body. Only a task request names a task. */
export function createRequestBody(form: RequestForm): Record<string, unknown> {
  return {
    category: form.category,
    subject: form.subject.trim(),
    description: form.description.trim(),
    ...(form.category === 'task' && form.task_id !== '' ? { task_id: form.task_id } : {}),
  };
}

/** Reject requires a reason (DOCUMENT 04 B13); approve takes an optional response. */
export function decisionBody(
  decision: 'approve' | 'reject',
  response: string,
): { readonly ok: true; readonly body: Record<string, string> } | { readonly ok: false } {
  const trimmed = response.trim();
  if (decision === 'reject' && trimmed === '') {
    return { ok: false };
  }
  return { ok: true, body: trimmed === '' ? {} : { admin_response: trimmed } };
}
