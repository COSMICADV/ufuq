/**
 * The domain events the pipeline consumes — DOCUMENT 19 "Architecture":
 * domain event → notification rule → recipient resolution → channel
 * dispatch → storage.
 *
 * Every module that has a moment publishes it through its own port, after
 * its transaction commits; this file is the union of those ports' events and
 * the one place an event's **identity** is defined.
 *
 * The event key is what makes delivery idempotent and what DOCUMENT 19 rule 3
 * ("once per threshold crossing", overdue "once per task, not daily") rests
 * on. Two publications of the same moment — a retry, an hourly scan that sees
 * the same overdue task again — have the same key and produce one set of
 * notifications. A *new* moment has a new key:
 *
 *   - a stock crossing is keyed by the movement that crossed the line, so
 *     a product that recovers and falls again is told again;
 *   - an overdue or approaching task by its deadline, so moving the deadline
 *     makes a new moment;
 *   - a goal milestone by goal and threshold: each of 25 / 50 / 75 / 100% is
 *     told once for a goal;
 *   - repeatable actions (assigning, editing, deactivating, regenerating a
 *     report) by a nonce the sink stamps on the event when it is published.
 *     Two edits are two moments even within the same millisecond; a retry
 *     carries the same nonce (it travels in the queued batch), so it is still
 *     the same moment.
 */

import type { AttendanceEvent } from '../attendance/attendance-events.js';
import type { EmployeeEvent } from '../employees/employee-events.js';
import type { GoalEvent } from '../goals/goal-events.js';
import type { InventoryEvent } from '../inventory/inventory-events.js';
import type { LeaveEvent } from '../leave/leave-events.js';
import type { PayrollEvent } from '../payroll/payroll-events.js';
import type { ReportEvent } from '../reports/report-events.js';
import type { RequestEvent } from '../requests/request-events.js';
import type { TaskEvent } from '../tasks/task-events.js';

export type SourceEvent = (
  | AttendanceEvent
  | EmployeeEvent
  | GoalEvent
  | InventoryEvent
  | LeaveEvent
  | PayrollEvent
  | ReportEvent
  | RequestEvent
  | TaskEvent
) & {
  /** Stamped by the sink on publication: the identity of a repeatable action. */
  readonly nonce?: string;
};

export function eventKey(event: SourceEvent): string {
  const at = event.nonce ?? event.occurredAt.toISOString();
  switch (event.type) {
    case 'attendance_correction_submitted':
    case 'correction_approved':
    case 'correction_rejected':
    case 'correction_cancelled':
      return `${event.type}:${event.correctionId}`;
    case 'missing_checkout':
      return `${event.type}:${event.attendanceRecordId}`;
    case 'tasks_need_reassignment':
      return `${event.type}:${event.employeeId}:${at}`;
    case 'goal_milestone':
      return `${event.type}:${event.goalId}:${String(event.milestone)}`;
    case 'goal_assigned':
      return `${event.type}:${event.goalId}`;
    case 'low_stock':
    case 'out_of_stock':
    case 'negative_stock':
    case 'stock_reconciliation_mismatch':
      return `${event.type}:${event.movementId ?? `${event.productId ?? '-'}:${at}`}`;
    case 'leave_request_submitted':
    case 'leave_approved':
    case 'leave_rejected':
    case 'leave_cancelled':
      return `${event.type}:${event.leaveRequestId}`;
    case 'payroll_generated':
    case 'payroll_finalized':
    case 'payroll_marked_paid':
      return `${event.type}:${event.periodId}`;
    case 'payroll_adjustment_created':
    case 'payroll_deduction_added':
    case 'payroll_bonus_added':
      return `${event.type}:${event.periodId}:${event.employeeId ?? '-'}:${at}`;
    case 'monthly_report_ready':
      return `${event.type}:${event.reportId}:${at}`;
    case 'report_export_completed':
    case 'report_export_failed':
      return `${event.type}:${event.exportId}`;
    case 'request_submitted':
    case 'request_reviewed':
    case 'request_cancelled':
      return `${event.type}:${event.requestId}`;
    case 'task_assigned':
    case 'task_updated':
      return `${event.type}:${event.taskId}:${event.assigneeEmployeeId}:${at}`;
    case 'task_overdue':
    case 'task_deadline_approaching':
      return `${event.type}:${event.taskId}:${event.deadline}`;
  }
}

/** An event as it travels through the retry queue: JSON, so the time is a string. */
export type QueuedSourceEvent = Omit<SourceEvent, 'occurredAt'> & { readonly occurredAt: string };

export function toQueued(event: SourceEvent): QueuedSourceEvent {
  return { ...event, occurredAt: event.occurredAt.toISOString() } as QueuedSourceEvent;
}

export function fromQueued(event: QueuedSourceEvent): SourceEvent {
  return { ...event, occurredAt: new Date(event.occurredAt) } as SourceEvent;
}
