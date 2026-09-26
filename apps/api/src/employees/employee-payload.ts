/**
 * Employee row → API payload, and → audit snapshot.
 *
 * One mapping for every endpoint (DOCUMENT 08 §1: snake_case in transport),
 * so a column can only reach a client by being written here. Three things
 * are deliberately never written here: the user's `password_hash`, the
 * invitation's `token_hash`, and anything salary-related (DOCUMENT 09 §8 —
 * salary is visible only through `employee.view_salary`, and no Phase 5
 * endpoint returns it).
 */

import type { Prisma } from '@ufuq/db';

/** The relations every employee read loads — names for display, never secrets. */
export const EMPLOYEE_INCLUDE = {
  department: { select: { id: true, nameAr: true, nameEn: true } },
  position: { select: { id: true, titleAr: true, titleEn: true } },
  manager: { select: { id: true, employeeCode: true, firstName: true, lastName: true } },
  workSchedule: { select: { id: true, name: true } },
  user: {
    select: {
      id: true,
      email: true,
      status: true,
      role: { select: { key: true } },
      invitation: { select: { expiresAt: true, acceptedAt: true } },
    },
  },
} as const satisfies Prisma.EmployeeInclude;

export type EmployeeRow = Prisma.EmployeeGetPayload<{ include: typeof EMPLOYEE_INCLUDE }>;

export interface EmployeePayload {
  readonly id: string;
  readonly employee_code: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly photo_path: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly department: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly position: {
    readonly id: string;
    readonly title_ar: string;
    readonly title_en: string;
  } | null;
  readonly manager: {
    readonly id: string;
    readonly employee_code: string;
    readonly first_name: string;
    readonly last_name: string;
  } | null;
  readonly work_schedule: { readonly id: string; readonly name: string };
  /** `YYYY-MM-DD` — a DATE, not an instant. */
  readonly joining_date: string;
  readonly status: string;
  readonly termination_date: string | null;
  /**
   * The login account (DOCUMENT 06 §3.2), so a screen can show whether the
   * invitation is still outstanding and offer to resend it. Null only for an
   * employee with no account, which Phase 5 never creates.
   */
  readonly account: {
    readonly status: string;
    readonly role_key: string;
    /** Set while an invitation is outstanding; null once accepted or never sent. */
    readonly invitation_expires_at: string | null;
  } | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function calendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function employeePayload(row: EmployeeRow): EmployeePayload {
  const invitation = row.user?.invitation ?? null;
  return {
    id: row.id,
    employee_code: row.employeeCode,
    first_name: row.firstName,
    last_name: row.lastName,
    photo_path: row.photoPath,
    email: row.email,
    phone: row.phone,
    department: row.department
      ? { id: row.department.id, name_ar: row.department.nameAr, name_en: row.department.nameEn }
      : null,
    position: row.position
      ? { id: row.position.id, title_ar: row.position.titleAr, title_en: row.position.titleEn }
      : null,
    manager: row.manager
      ? {
          id: row.manager.id,
          employee_code: row.manager.employeeCode,
          first_name: row.manager.firstName,
          last_name: row.manager.lastName,
        }
      : null,
    work_schedule: { id: row.workSchedule.id, name: row.workSchedule.name },
    joining_date: calendarDate(row.joiningDate),
    status: row.status,
    termination_date: row.terminationDate === null ? null : calendarDate(row.terminationDate),
    account: row.user
      ? {
          status: row.user.status,
          role_key: row.user.role.key,
          invitation_expires_at:
            row.user.status === 'invited' && invitation !== null && invitation.acceptedAt === null
              ? invitation.expiresAt.toISOString()
              : null,
        }
      : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * The employee fields an audit record compares — DOCUMENT 21 "Record content":
 * only changed fields are stored, and nothing sensitive is.
 */
export type EmployeeAuditSnapshot = Readonly<Record<string, string | null>>;

export function employeeAuditSnapshot(row: EmployeeRow): EmployeeAuditSnapshot {
  return {
    employee_code: row.employeeCode,
    first_name: row.firstName,
    last_name: row.lastName,
    email: row.email,
    phone: row.phone,
    department_id: row.departmentId,
    position_id: row.positionId,
    manager_id: row.managerId,
    work_schedule_id: row.workScheduleId,
    joining_date: calendarDate(row.joiningDate),
    status: row.status,
  };
}

/** The keys whose values differ between two snapshots, as old/new maps. */
export function diffSnapshots(
  before: EmployeeAuditSnapshot,
  after: EmployeeAuditSnapshot,
  keys: readonly string[],
): { oldValues: Record<string, string | null>; newValues: Record<string, string | null> } {
  const oldValues: Record<string, string | null> = {};
  const newValues: Record<string, string | null> = {};
  for (const key of keys) {
    if (before[key] !== after[key]) {
      oldValues[key] = before[key] ?? null;
      newValues[key] = after[key] ?? null;
    }
  }
  return { oldValues, newValues };
}
