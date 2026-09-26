/**
 * Attendance rows → the DOCUMENT 08 §1 wire shape (snake_case).
 *
 * Times go out as ISO instants and dates as `YYYY-MM-DD`. The client is never
 * asked to work out which day an instant belongs to — the server already knows,
 * because it evaluated the day in the schedule's zone (DOCUMENT 12 "Timezone").
 */

import type { Prisma } from '@ufuq/db';

export const ATTENDANCE_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      department: { select: { id: true, nameAr: true, nameEn: true } },
    },
  },
} as const;

export type AttendanceRow = Prisma.AttendanceRecordGetPayload<{
  include: typeof ATTENDANCE_INCLUDE;
}>;

export interface AttendanceEmployeeRef {
  readonly id: string;
  readonly employee_code: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly department: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
}

export interface AttendancePayload {
  readonly id: string;
  readonly date: string;
  readonly employee: AttendanceEmployeeRef;
  readonly work_mode: 'office' | 'wfh' | null;
  readonly check_in_at: string | null;
  readonly check_out_at: string | null;
  readonly working_minutes: number | null;
  readonly overtime_minutes: number | null;
  readonly late_minutes: number | null;
  readonly status: string;
  readonly source: string;
  readonly note: string | null;
}

/** A `@db.Date` comes back as midnight UTC; the first ten characters are the day. */
export function dateToWire(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The employee half of an attendance row — also the employee profile month's header. */
export function attendanceEmployeeRef(employee: AttendanceRow['employee']): AttendanceEmployeeRef {
  return {
    id: employee.id,
    employee_code: employee.employeeCode,
    first_name: employee.firstName,
    last_name: employee.lastName,
    department:
      employee.department === null
        ? null
        : {
            id: employee.department.id,
            name_ar: employee.department.nameAr,
            name_en: employee.department.nameEn,
          },
  };
}

export function attendancePayload(row: AttendanceRow): AttendancePayload {
  return {
    id: row.id,
    date: dateToWire(row.date),
    employee: attendanceEmployeeRef(row.employee),
    work_mode: row.workMode,
    check_in_at: row.checkInAt?.toISOString() ?? null,
    check_out_at: row.checkOutAt?.toISOString() ?? null,
    working_minutes: row.workingMinutes,
    overtime_minutes: row.overtimeMinutes,
    late_minutes: row.lateMinutes,
    status: row.status,
    source: row.source,
    note: row.note,
  };
}

/**
 * What an admin adjustment changed — DOCUMENT 21 requires old and new values.
 * Only the fields an adjustment may touch are snapshotted; `created_at` and
 * friends would be noise in an audit record.
 */
export function attendanceAuditSnapshot(row: {
  readonly workMode: string | null;
  readonly checkInAt: Date | null;
  readonly checkOutAt: Date | null;
  readonly workingMinutes: number | null;
  readonly overtimeMinutes: number | null;
  readonly lateMinutes: number | null;
  readonly status: string;
  readonly source: string;
  readonly note: string | null;
}): Prisma.InputJsonObject {
  return {
    work_mode: row.workMode,
    check_in_at: row.checkInAt?.toISOString() ?? null,
    check_out_at: row.checkOutAt?.toISOString() ?? null,
    working_minutes: row.workingMinutes,
    overtime_minutes: row.overtimeMinutes,
    late_minutes: row.lateMinutes,
    status: row.status,
    source: row.source,
    note: row.note,
  };
}

export const CORRECTION_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      department: { select: { id: true, nameAr: true, nameEn: true } },
    },
  },
  attendanceRecord: { include: ATTENDANCE_INCLUDE },
} as const;

export type CorrectionRow = Prisma.AttendanceCorrectionRequestGetPayload<{
  include: typeof CORRECTION_INCLUDE;
}>;

export interface CorrectionPayload {
  readonly id: string;
  readonly date: string;
  readonly employee: AttendanceEmployeeRef;
  readonly requested_check_in: string | null;
  readonly requested_check_out: string | null;
  readonly requested_work_mode: 'office' | 'wfh' | null;
  readonly reason: string;
  readonly status: string;
  readonly reviewed_at: string | null;
  readonly review_note: string | null;
  /**
   * DOCUMENT 04 B7 — "current recorded values vs requested values side by
   * side". The screen cannot show the comparison without the current record,
   * and fetching it separately per row would be a request per list item.
   */
  readonly current: AttendancePayload | null;
}

export function correctionPayload(row: CorrectionRow): CorrectionPayload {
  return {
    id: row.id,
    date: dateToWire(row.date),
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
    requested_check_in: row.requestedCheckIn?.toISOString() ?? null,
    requested_check_out: row.requestedCheckOut?.toISOString() ?? null,
    requested_work_mode: row.requestedWorkMode,
    reason: row.reason,
    status: row.status,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    review_note: row.reviewNote,
    current: row.attendanceRecord === null ? null : attendancePayload(row.attendanceRecord),
  };
}
