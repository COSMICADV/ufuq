/**
 * `requests` rows → the wire — DOCUMENT 08 §1 (snake_case, ISO 8601),
 * DOCUMENT 04 B13 (row: employee, category chip, summary, submitted date, age,
 * status) and C10 (detail: decision, reviewer, admin response).
 *
 * An attendance row carries its specialised record (`attendance`), because
 * the inbox and the detail both need "the relevant attendance record for
 * corrections" (B13) and the summary of an attendance row *is* that record.
 */

import type { Prisma } from '@ufuq/db';

import type { AttachmentPayload } from '../attachments/attachment-payload.js';
import type { CorrectionPayload } from '../attendance/attendance-payload.js';
import type { LeaveRequestDetailPayload } from '../leave/leave-payload.js';
import { PERSON_SELECT, personRef } from '../tasks/task-payload.js';
import type { PersonRef } from '../tasks/task-payload.js';

import type { RequestCategoryValue, RequestStatusValue } from './request-rules.js';

export const REQUEST_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      department: { select: { id: true, nameAr: true, nameEn: true } },
    },
  },
  reviewer: { select: PERSON_SELECT },
} as const satisfies Prisma.RequestInclude;

export type RequestRow = Prisma.RequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export interface RequestTaskRef {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export interface RequestAbilities {
  /** Approve and reject: pending, in the caller's review scope, and not their own (OD-03). */
  readonly can_review: boolean;
  /** The caller's own request, while it is pending (DOCUMENT 02 `request.cancel`). */
  readonly can_cancel: boolean;
}

export interface RequestPayload {
  readonly id: string;
  readonly category: RequestCategoryValue;
  readonly status: RequestStatusValue;
  readonly subject: string | null;
  readonly description: string | null;
  readonly employee: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly department: {
      readonly id: string;
      readonly name_ar: string;
      readonly name_en: string;
    } | null;
  };
  readonly related_type: string | null;
  readonly related_id: string | null;
  /** Task category: the task the request is about, when one was named. */
  readonly task: RequestTaskRef | null;
  /** Attendance category: the correction this row indexes (OD-09). */
  readonly attendance: CorrectionPayload | null;
  /** Leave category: the leave request this row indexes, with its balances (OD-09, B13). */
  readonly leave: LeaveRequestDetailPayload | null;
  readonly reviewed_by: PersonRef | null;
  readonly reviewed_at: string | null;
  readonly admin_response: string | null;
  readonly created_at: string;
  /** True when the caller is the requester — the screen's "you" marker. */
  readonly is_own: boolean;
  readonly abilities: RequestAbilities;
}

export interface RequestDetailPayload extends RequestPayload {
  readonly attachments: readonly AttachmentPayload[];
  readonly attachment_abilities: { readonly can_upload: boolean; readonly can_delete: boolean };
}

export function requestPayload(
  row: RequestRow,
  extras: {
    readonly task: RequestTaskRef | null;
    readonly attendance: CorrectionPayload | null;
    readonly leave: LeaveRequestDetailPayload | null;
    readonly isOwn: boolean;
    readonly abilities: RequestAbilities;
  },
): RequestPayload {
  return {
    id: row.id,
    category: row.category,
    status: row.status,
    subject: row.subject,
    description: row.description,
    employee: {
      id: row.employee.id,
      employee_code: row.employee.employeeCode,
      first_name: row.employee.firstName,
      last_name: row.employee.lastName,
      department:
        row.employee.department === null
          ? null
          : {
              id: row.employee.department.id,
              name_ar: row.employee.department.nameAr,
              name_en: row.employee.department.nameEn,
            },
    },
    related_type: row.relatedType,
    related_id: row.relatedId,
    task: extras.task,
    attendance: extras.attendance,
    leave: extras.leave,
    reviewed_by: row.reviewer === null ? null : personRef(row.reviewer),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    admin_response: row.adminResponse,
    created_at: row.createdAt.toISOString(),
    is_own: extras.isOwn,
    abilities: extras.abilities,
  };
}

/** DOCUMENT 21 "only the fields that changed" — the decision half of a request. */
export function decisionSnapshot(row: {
  status: string;
  reviewedAt: Date | null;
  adminResponse: string | null;
}): Prisma.InputJsonObject {
  return {
    status: row.status,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    admin_response: row.adminResponse,
  };
}
