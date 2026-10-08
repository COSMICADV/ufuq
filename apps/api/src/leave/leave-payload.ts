/**
 * Leave rows → the wire — DOCUMENT 08 §1 (snake_case, ISO 8601, decimals as
 * strings). Remaining is computed here from the stored figures and never
 * read from a column (DOCUMENT 16).
 */

import type { Prisma } from '@ufuq/db';

import type { AttachmentPayload } from '../attachments/attachment-payload.js';
import { ATTACHMENT_INCLUDE, attachmentPayload } from '../attachments/attachment-payload.js';
import { dateToWire } from '../attendance/attendance-payload.js';
import { PERSON_SELECT, personRef } from '../tasks/task-payload.js';
import type { PersonRef } from '../tasks/task-payload.js';

import { days, remaining } from './leave-rules.js';
import type { CarryOverPolicyValue, LeaveRequestStatusValue } from './leave-rules.js';

export interface LeaveTypePayload {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_paid: boolean;
  readonly default_days_per_year: string;
  readonly requires_attachment: boolean;
  readonly allows_negative_balance: boolean;
  readonly carry_over_policy: CarryOverPolicyValue;
  readonly carry_over_cap: string | null;
  readonly is_active: boolean;
}

type LeaveTypeRow = Prisma.LeaveTypeGetPayload<Record<string, never>>;

export function leaveTypePayload(row: LeaveTypeRow): LeaveTypePayload {
  return {
    id: row.id,
    name_ar: row.nameAr,
    name_en: row.nameEn,
    is_paid: row.isPaid,
    default_days_per_year: days(row.defaultDaysPerYear).toString(),
    requires_attachment: row.requiresAttachment,
    allows_negative_balance: row.allowsNegativeBalance,
    carry_over_policy: row.carryOverPolicy,
    carry_over_cap: row.carryOverCap === null ? null : days(row.carryOverCap).toString(),
    is_active: row.deletedAt === null,
  };
}

/** The fields an audit record of a type change compares (DOCUMENT 21: only what changed). */
export function leaveTypeSnapshot(row: LeaveTypeRow): Record<string, string | boolean | null> {
  const payload = leaveTypePayload(row);
  return { ...payload, id: null } as unknown as Record<string, string | boolean | null>;
}

const EMPLOYEE_REF_SELECT = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
} as const;

export interface LeaveEmployeeRef {
  readonly id: string;
  readonly employee_code: string;
  readonly first_name: string;
  readonly last_name: string;
}

function employeeRef(row: {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
}): LeaveEmployeeRef {
  return {
    id: row.id,
    employee_code: row.employeeCode,
    first_name: row.firstName,
    last_name: row.lastName,
  };
}

export const LEAVE_TYPE_REF_SELECT = {
  id: true,
  nameAr: true,
  nameEn: true,
  isPaid: true,
  allowsNegativeBalance: true,
  requiresAttachment: true,
} as const;

export interface LeaveTypeRef {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_paid: boolean;
}

function typeRef(row: {
  id: string;
  nameAr: string;
  nameEn: string;
  isPaid: boolean;
}): LeaveTypeRef {
  return { id: row.id, name_ar: row.nameAr, name_en: row.nameEn, is_paid: row.isPaid };
}

// -- Balances -------------------------------------------------------------------

export const LEAVE_BALANCE_INCLUDE = {
  employee: { select: EMPLOYEE_REF_SELECT },
  leaveType: { select: LEAVE_TYPE_REF_SELECT },
} as const satisfies Prisma.LeaveBalanceInclude;

export type LeaveBalanceRow = Prisma.LeaveBalanceGetPayload<{
  include: typeof LEAVE_BALANCE_INCLUDE;
}>;

export interface LeaveBalancePayload {
  readonly id: string;
  readonly employee: LeaveEmployeeRef;
  readonly leave_type: LeaveTypeRef;
  readonly year: number;
  readonly total_days: string;
  readonly used_days: string;
  readonly pending_days: string;
  readonly carried_over_days: string;
  /** Computed: total + carried_over − used − pending. May be negative where the type allows it. */
  readonly remaining_days: string;
}

export function leaveBalancePayload(row: LeaveBalanceRow): LeaveBalancePayload {
  const figures = {
    totalDays: days(row.totalDays),
    usedDays: days(row.usedDays),
    pendingDays: days(row.pendingDays),
    carriedOverDays: days(row.carriedOverDays),
  };
  return {
    id: row.id,
    employee: employeeRef(row.employee),
    leave_type: typeRef(row.leaveType),
    year: row.year,
    total_days: figures.totalDays.toString(),
    used_days: figures.usedDays.toString(),
    pending_days: figures.pendingDays.toString(),
    carried_over_days: figures.carriedOverDays.toString(),
    remaining_days: remaining(figures).toString(),
  };
}

export function balanceSnapshot(row: {
  totalDays: { toString(): string };
  carriedOverDays: { toString(): string };
}): Prisma.InputJsonObject {
  return {
    total_days: days(row.totalDays).toString(),
    carried_over_days: days(row.carriedOverDays).toString(),
  };
}

// -- Requests -------------------------------------------------------------------

export const LEAVE_REQUEST_INCLUDE = {
  employee: { select: { ...EMPLOYEE_REF_SELECT, joiningDate: true, workScheduleId: true } },
  leaveType: { select: LEAVE_TYPE_REF_SELECT },
  reviewer: { select: PERSON_SELECT },
  attachment: { include: ATTACHMENT_INCLUDE },
} as const satisfies Prisma.LeaveRequestInclude;

export type LeaveRequestRow = Prisma.LeaveRequestGetPayload<{
  include: typeof LEAVE_REQUEST_INCLUDE;
}>;

export interface LeaveRequestPayload {
  readonly id: string;
  readonly employee: LeaveEmployeeRef;
  readonly leave_type: LeaveTypeRef;
  readonly start_date: string;
  readonly end_date: string;
  readonly days_count: string;
  /** Days per calendar year (DOCUMENT 16 "Leave spanning two years"). */
  readonly year_allocation: Record<string, string>;
  readonly reason: string;
  readonly attachment: AttachmentPayload | null;
  readonly status: LeaveRequestStatusValue;
  readonly reviewed_by: PersonRef | null;
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  readonly created_at: string;
  readonly is_own: boolean;
  readonly abilities: {
    /** Approve / reject: pending, in `leave.approve` scope, not the caller's own (OD-03). */
    readonly can_review: boolean;
    /** The requester, while pending. */
    readonly can_cancel: boolean;
    /** An ADMIN cancelling approved leave (DOCUMENT 16 rule 15). */
    readonly can_cancel_approved: boolean;
  };
}

export interface LeaveRequestDetailPayload extends LeaveRequestPayload {
  /** DOCUMENT 04 B13: "leave balance for leave requests" — this type, the years the leave touches. */
  readonly balances: readonly LeaveBalancePayload[];
  /**
   * DOCUMENT 16 "Holiday declared inside approved leave": days of this
   * approved leave that have since become holidays. Never recalculated
   * silently — an ADMIN corrects the balance explicitly (PATCH
   * /leave-balances/{id}, with a reason).
   */
  readonly holidays_inside: readonly string[];
}

export function leaveRequestPayload(
  row: LeaveRequestRow,
  extras: { readonly isOwn: boolean; readonly abilities: LeaveRequestPayload['abilities'] },
): LeaveRequestPayload {
  return {
    id: row.id,
    employee: employeeRef(row.employee),
    leave_type: typeRef(row.leaveType),
    start_date: dateToWire(row.startDate),
    end_date: dateToWire(row.endDate),
    days_count: days(row.daysCount).toString(),
    year_allocation: row.yearAllocation as Record<string, string>,
    reason: row.reason,
    attachment:
      row.attachment === null || row.attachment.deletedAt !== null
        ? null
        : attachmentPayload(row.attachment),
    status: row.status,
    reviewed_by: row.reviewer === null ? null : personRef(row.reviewer),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_note: row.reviewNote,
    created_at: row.createdAt.toISOString(),
    is_own: extras.isOwn,
    abilities: extras.abilities,
  };
}
