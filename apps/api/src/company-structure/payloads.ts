/**
 * Database row → API payload.
 *
 * DOCUMENT 08 §1 fixes the transport naming as snake_case, and §2's own
 * examples (`message_ar`, `per_page`, `total_pages`, and the `POST /employees`
 * body in §4.3) are written that way. Prisma models are camelCase because
 * that is what a TypeScript client reads well. The two conventions meet here,
 * in one file, rather than at each handler — a payload assembled inline in a
 * controller is how a field ends up spelled two ways in one API.
 *
 * Mapping explicitly also means a column can never leak by accident. The
 * `companies` row carries `deleted_at` and `created_by`; neither is anyone's
 * business over HTTP, and neither can appear here by forgetting to exclude it.
 */

import { Decimal } from '@ufuq/money';
import type {
  Company,
  Department,
  Holiday,
  Position,
  WorkSchedule,
  WorkScheduleDay,
} from '@ufuq/db';

import { formatTimeOfDay, HOURS_SCALE } from './validation.js';

export interface CompanyPayload {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logo_path: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly default_locale: string;
  readonly fiscal_month_start_day: number;
  readonly correction_window_days: number;
  readonly status: string;
}

export function companyPayload(row: Company): CompanyPayload {
  return {
    id: row.id,
    name: row.name,
    // Read-only in Phase 4: the approved editable field list does not include
    // it, but a settings screen still has to be able to show it.
    slug: row.slug,
    logo_path: row.logoPath,
    timezone: row.timezone,
    // `currency` is CHAR(3) and `default_locale` CHAR(5) (DOCUMENT 06 §3.1).
    // PostgreSQL blank-pads a CHAR column, so a two-letter locale comes back
    // as `"ar   "`. Trimming here is presentation, not a schema opinion: the
    // API contract says the value is `ar` or `en`, and three trailing spaces
    // would break any client comparing against that.
    currency: row.currency.trim(),
    default_locale: row.defaultLocale.trim(),
    fiscal_month_start_day: row.fiscalMonthStartDay,
    correction_window_days: row.correctionWindowDays,
    status: row.status,
  };
}

export interface DepartmentPayload {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly parent_id: string | null;
  readonly manager_employee_id: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function departmentPayload(row: Department): DepartmentPayload {
  return {
    id: row.id,
    name_ar: row.nameAr,
    name_en: row.nameEn,
    parent_id: row.parentId,
    manager_employee_id: row.managerEmployeeId,
    status: row.status,
    // DOCUMENT 08 §1: ISO 8601, UTC in transport. The company timezone is a
    // presentation concern and belongs to whoever renders the value.
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface PositionPayload {
  readonly id: string;
  readonly title_ar: string;
  readonly title_en: string;
  readonly department_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function positionPayload(row: Position): PositionPayload {
  return {
    id: row.id,
    title_ar: row.titleAr,
    title_en: row.titleEn,
    department_id: row.departmentId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface WorkScheduleDayPayload {
  readonly day_of_week: number;
  readonly is_working_day: boolean;
  readonly start_time: string | null;
  readonly end_time: string | null;
}

export interface WorkSchedulePayload {
  readonly id: string;
  readonly name: string;
  readonly is_default: boolean;
  readonly timezone: string;
  readonly grace_period_minutes: number;
  readonly half_day_threshold_hours: string;
  readonly overtime_policy: string;
  readonly break_minutes: number;
  readonly days: readonly WorkScheduleDayPayload[];
  readonly created_at: string;
  readonly updated_at: string;
}

export function workScheduleDayPayload(row: WorkScheduleDay): WorkScheduleDayPayload {
  return {
    day_of_week: row.dayOfWeek,
    is_working_day: row.isWorkingDay,
    start_time: row.startTime === null ? null : formatTimeOfDay(row.startTime),
    end_time: row.endTime === null ? null : formatTimeOfDay(row.endTime),
  };
}

export function workSchedulePayload(
  row: WorkSchedule & { readonly days: readonly WorkScheduleDay[] },
): WorkSchedulePayload {
  return {
    id: row.id,
    name: row.name,
    is_default: row.isDefault,
    timezone: row.timezone,
    grace_period_minutes: row.gracePeriodMinutes,
    // Prisma's own Decimal renders "4.5"; the transport value is fixed-scale,
    // so it goes back through the workspace's one decimal implementation to
    // come out as "4.50" every time (DOCUMENT 27 RULE 6).
    half_day_threshold_hours: Decimal.parse(
      row.halfDayThresholdHours.toString(),
      HOURS_SCALE,
    ).toString(),
    overtime_policy: row.overtimePolicy,
    break_minutes: row.breakMinutes,
    days: row.days.map(workScheduleDayPayload),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export interface HolidayPayload {
  readonly id: string;
  readonly date: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly is_recurring: boolean;
}

export function holidayPayload(row: Holiday): HolidayPayload {
  return {
    id: row.id,
    // A DATE column, not an instant: rendering it as a full ISO timestamp
    // would invite a client to shift it by its own offset and land on the
    // previous day.
    date: row.date.toISOString().slice(0, 10),
    name_ar: row.nameAr,
    name_en: row.nameEn,
    is_recurring: row.isRecurring,
  };
}
