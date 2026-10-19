/**
 * The notification catalogue — DOCUMENT 19's two tables, plus DOCUMENT 18's
 * background-export outcomes.
 *
 * One entry per type: its documented priority, which side of the product it
 * belongs to (`admin` — the admin / manager table; `employee` — the employee
 * table), the kind of record it links to (DOCUMENT 19 rule 5), and whether a
 * company may turn it off (DOCUMENT 19 rule 10). `goal_milestone` is in both
 * tables; the audience of each notification is decided by its recipient
 * (the owner is told as an employee, the manager as a manager).
 */

import type { NotificationPriority, NotificationType } from '@ufuq/db';

export type NotificationAudience = 'admin' | 'employee';

/** The kinds of source record a notification links to (the table's CHECK). */
export type RelatedType =
  | 'request'
  | 'task'
  | 'goal'
  | 'product'
  | 'payroll_period'
  | 'attendance_record'
  | 'employee'
  | 'monthly_report'
  | 'report_export';

export interface NotificationTypeDefinition {
  readonly type: NotificationType;
  readonly priority: NotificationPriority;
  readonly audience: NotificationAudience;
  readonly relatedType: RelatedType;
}

/** V1 delivers in the app only (DOCUMENT 19 "Channels"). */
export const V1_CHANNELS = ['in_app'] as const;
export type V1Channel = (typeof V1_CHANNELS)[number];

function define(
  type: NotificationType,
  priority: NotificationPriority,
  audience: NotificationAudience,
  relatedType: RelatedType,
): NotificationTypeDefinition {
  return { type, priority, audience, relatedType };
}

export const NOTIFICATION_TYPES: readonly NotificationTypeDefinition[] = [
  // DOCUMENT 19 "Admin / manager notifications"
  define('leave_request_submitted', 'high', 'admin', 'request'),
  define('attendance_correction_submitted', 'high', 'admin', 'request'),
  define('request_submitted', 'medium', 'admin', 'request'),
  define('task_overdue', 'medium', 'admin', 'task'),
  define('low_stock', 'high', 'admin', 'product'),
  define('out_of_stock', 'high', 'admin', 'product'),
  define('goal_milestone', 'low', 'admin', 'goal'),
  define('payroll_ready', 'high', 'admin', 'payroll_period'),
  define('employee_missing_checkout', 'low', 'admin', 'attendance_record'),
  define('tasks_need_reassignment', 'medium', 'admin', 'employee'),
  // DOCUMENT 19 "Employee notifications"
  define('task_assigned', 'high', 'employee', 'task'),
  define('task_deadline_approaching', 'medium', 'employee', 'task'),
  define('task_updated', 'low', 'employee', 'task'),
  define('leave_approved', 'high', 'employee', 'request'),
  define('leave_rejected', 'high', 'employee', 'request'),
  define('correction_approved', 'high', 'employee', 'request'),
  define('correction_rejected', 'high', 'employee', 'request'),
  define('request_reviewed', 'medium', 'employee', 'request'),
  define('salary_finalized', 'high', 'employee', 'payroll_period'),
  define('goal_assigned', 'medium', 'employee', 'goal'),
  define('monthly_report_ready', 'low', 'employee', 'monthly_report'),
  define('missing_checkout', 'medium', 'employee', 'attendance_record'),
  // DOCUMENT 18 "Performance" / "Error states" — the requester of a
  // background export. Neither table lists them; DOCUMENT 19 amended.
  define('report_export_completed', 'low', 'admin', 'report_export'),
  define('report_export_failed', 'medium', 'admin', 'report_export'),
];

const BY_TYPE = new Map(NOTIFICATION_TYPES.map((definition) => [definition.type, definition]));

export function definitionOf(type: NotificationType): NotificationTypeDefinition {
  const definition = BY_TYPE.get(type);
  if (definition === undefined) {
    throw new Error(`Unknown notification type: ${type}`);
  }
  return definition;
}

export function isNotificationType(value: string): value is NotificationType {
  return BY_TYPE.has(value as NotificationType);
}

/**
 * DOCUMENT 19 rule 4 — "more than 3 notifications of the same type for the
 * same user within an hour are collapsed into one summary".
 */
export const GROUPING_THRESHOLD = 3;
export const GROUPING_WINDOW_MS = 60 * 60 * 1000;

/** DOCUMENT 19 rule 8 / DOCUMENT 06 "Retention": 12 months. */
export const RETENTION_MONTHS = 12;

/** The feed's page bounds. */
export const FEED_DEFAULT_PAGE_SIZE = 20;
export const FEED_MAX_PAGE_SIZE = 50;
