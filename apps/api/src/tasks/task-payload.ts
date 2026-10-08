/**
 * Task rows → the DOCUMENT 08 §1 wire shape (snake_case).
 *
 * Two values are derived here on every read rather than stored:
 *
 *   - `is_overdue` — DOCUMENT 13 rule 1, against the company's calendar day.
 *   - `allowed_transitions` — DOCUMENT 13 rule 4, so a screen offers only the
 *     moves the server will accept. The server still validates every one.
 *
 * Percentages go out as DECIMAL(5,2) strings ("75.00"), the same way money
 * does (DOCUMENT 08 §1): a binary float is not what the column holds.
 */

import type { Prisma } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { dateToWire } from '../attendance/attendance-payload.js';

import { PERCENT_SCALE, allowedTransitions, isOverdue } from './task-rules.js';
import type { TaskPriorityValue, TaskStatusValue } from './task-rules.js';
import type { AttachmentPayload } from '../attachments/attachment-payload.js';

const PERSON_SELECT = {
  id: true,
  email: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

export const TASK_LIST_INCLUDE = {
  assignee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      status: true,
    },
  },
  department: { select: { id: true, nameAr: true, nameEn: true } },
  createdByUser: { select: PERSON_SELECT },
  checklistItems: { select: { isCompleted: true } },
  goal: { select: { id: true, title: true, type: true, status: true } },
} as const;

export const TASK_DETAIL_INCLUDE = {
  ...TASK_LIST_INCLUDE,
  checklistItems: {
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    include: { completedByUser: { select: PERSON_SELECT } },
  },
} as const satisfies Prisma.TaskInclude;

export type TaskListRow = Prisma.TaskGetPayload<{ include: typeof TASK_LIST_INCLUDE }>;
export type TaskDetailRow = Prisma.TaskGetPayload<{ include: typeof TASK_DETAIL_INCLUDE }>;

export const PROGRESS_UPDATE_INCLUDE = {
  createdByUser: { select: PERSON_SELECT },
} as const;

export type ProgressUpdateRow = Prisma.TaskProgressUpdateGetPayload<{
  include: typeof PROGRESS_UPDATE_INCLUDE;
}>;

export interface PersonRef {
  readonly user_id: string;
  readonly employee_id: string | null;
  /** The employee's name, or the account email when there is no employee record. */
  readonly name: string;
}

export interface TaskPayload {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly assignee: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly status: string;
  };
  readonly department: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly priority: TaskPriorityValue;
  readonly status: TaskStatusValue;
  /** DOCUMENT 04 B9 "linked goal" (Phase 8). */
  readonly goal: {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly status: string;
  } | null;
  readonly start_date: string | null;
  readonly deadline: string | null;
  readonly completed_at: string | null;
  readonly progress_percent: string;
  readonly is_overdue: boolean;
  readonly cancelled_reason: string | null;
  readonly checklist_total: number;
  readonly checklist_completed: number;
  readonly allowed_transitions: readonly TaskStatusValue[];
  readonly created_by: PersonRef;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChecklistItemPayload {
  readonly id: string;
  readonly title: string;
  readonly is_completed: boolean;
  readonly completed_at: string | null;
  readonly completed_by: PersonRef | null;
  readonly position: number;
}

export interface TaskDetailPayload extends TaskPayload {
  readonly checklist: readonly ChecklistItemPayload[];
}

/**
 * `GET /tasks/{id}` only — the task with its files (Phase 7 addendum). The
 * write endpoints keep returning {@link TaskDetailPayload}; a screen keeps the
 * attachments it loaded and updates them from the attachment endpoints.
 *
 * `can_upload` / `can_delete` are the server's own answers
 * (`TaskAttachmentPolicy`), so a screen offers only what the API will accept —
 * the `allowed_transitions` pattern.
 */
export interface TaskWithAttachmentsPayload extends TaskDetailPayload {
  readonly attachments: {
    readonly items: readonly AttachmentPayload[];
    readonly can_upload: boolean;
    readonly can_delete: boolean;
  };
}

export interface ProgressUpdatePayload {
  readonly id: string;
  readonly task_id: string;
  readonly note: string;
  readonly progress_percent_at_time: string;
  readonly author: PersonRef;
  readonly created_at: string;
}

type PersonRow = TaskListRow['createdByUser'];

export function personRef(user: PersonRow): PersonRef {
  return {
    user_id: user.id,
    employee_id: user.employee?.id ?? null,
    name:
      user.employee === null ? user.email : `${user.employee.firstName} ${user.employee.lastName}`,
  };
}

/**
 * DECIMAL(5,2) as its two-decimal string. Prisma's own Decimal renders "50";
 * the transport value is fixed-scale, so it goes through the workspace's one
 * decimal implementation to come out as "50.00" every time — the Phase 4
 * `half_day_threshold_hours` pattern.
 */
export function percentToWire(value: Prisma.Decimal): string {
  return Decimal.parse(value.toString(), PERCENT_SCALE).toString();
}

export function taskPayload(row: TaskListRow | TaskDetailRow, today: string): TaskPayload {
  const status = row.status as TaskStatusValue;
  const deadline = row.deadline === null ? null : dateToWire(row.deadline);
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    assignee: {
      id: row.assignee.id,
      employee_code: row.assignee.employeeCode,
      first_name: row.assignee.firstName,
      last_name: row.assignee.lastName,
      status: row.assignee.status,
    },
    department:
      row.department === null
        ? null
        : { id: row.department.id, name_ar: row.department.nameAr, name_en: row.department.nameEn },
    priority: row.priority as TaskPriorityValue,
    status,
    goal:
      row.goal === null
        ? null
        : { id: row.goal.id, title: row.goal.title, type: row.goal.type, status: row.goal.status },
    start_date: row.startDate === null ? null : dateToWire(row.startDate),
    deadline,
    completed_at: row.completedAt?.toISOString() ?? null,
    progress_percent: percentToWire(row.progressPercent),
    is_overdue: isOverdue({ deadline, status }, today),
    cancelled_reason: row.cancelledReason,
    checklist_total: row.checklistItems.length,
    checklist_completed: row.checklistItems.filter((item) => item.isCompleted).length,
    allowed_transitions: allowedTransitions(status),
    created_by: personRef(row.createdByUser),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export function taskDetailPayload(row: TaskDetailRow, today: string): TaskDetailPayload {
  return {
    ...taskPayload(row, today),
    checklist: row.checklistItems.map((item) => ({
      id: item.id,
      title: item.title,
      is_completed: item.isCompleted,
      completed_at: item.completedAt?.toISOString() ?? null,
      completed_by: item.completedByUser === null ? null : personRef(item.completedByUser),
      position: item.position,
    })),
  };
}

export function progressUpdatePayload(row: ProgressUpdateRow): ProgressUpdatePayload {
  return {
    id: row.id,
    task_id: row.taskId,
    note: row.note,
    progress_percent_at_time: percentToWire(row.progressPercentAtTime),
    author: personRef(row.createdByUser),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * The fields an audit record of a task edit may name — DOCUMENT 21 "only the
 * fields that changed". Dates as `YYYY-MM-DD`, the percentage as a string.
 * Diffed with the employees module's `diffSnapshots`, which takes exactly this
 * shape (DOCUMENT 27 RULE 6).
 */
export type TaskAuditSnapshot = Readonly<Record<string, string | null>>;

export function taskAuditSnapshot(row: {
  readonly title: string;
  readonly description: string | null;
  readonly assigneeEmployeeId: string;
  readonly departmentId: string | null;
  readonly priority: string;
  readonly status: string;
  readonly startDate: Date | null;
  readonly deadline: Date | null;
  readonly progressPercent: Prisma.Decimal;
  readonly cancelledReason: string | null;
  readonly goalId: string | null;
}): TaskAuditSnapshot {
  return {
    title: row.title,
    description: row.description,
    assignee_employee_id: row.assigneeEmployeeId,
    department_id: row.departmentId,
    priority: row.priority,
    status: row.status,
    start_date: row.startDate === null ? null : dateToWire(row.startDate),
    deadline: row.deadline === null ? null : dateToWire(row.deadline),
    progress_percent: percentToWire(row.progressPercent),
    cancelled_reason: row.cancelledReason,
    goal_id: row.goalId,
  };
}
