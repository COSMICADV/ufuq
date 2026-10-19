/**
 * Report requests — DOCUMENT 08 §4.12, DOCUMENT 18 "Filters".
 *
 * One whitelisted set of filter fields (unknown fields are rejected by the
 * global validation pipe). Which of them a given report accepts is checked by
 * `report-filters.ts`: a filter that means nothing for the report asked for is
 * a 422 `not_allowed`, never silently ignored — a printed report must state
 * exactly the filters it was produced with (DOCUMENT 18 rule 7).
 */

import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

import { IsCalendarDate, NumericInput } from '../../company-structure/validation.js';
import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';

export const WORK_MODES = ['office', 'wfh'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const GOAL_TYPES = ['sales', 'task', 'custom'] as const;
export const MOVEMENT_TYPES = [
  'purchase',
  'sale',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'return',
  'damage',
  'manual_addition',
  'manual_removal',
] as const;
export const PRODUCT_STATUSES = ['active', 'discontinued'] as const;

/** Every status a report can be filtered by; each report accepts its own subset. */
export const REPORT_STATUSES = [
  // attendance
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
  'holiday',
  'weekend',
  'pending',
  // employees (performance)
  'active',
  'inactive',
  'terminated',
  // tasks
  'not_started',
  'in_progress',
  'completed',
  'cancelled',
  'on_hold',
  // goals
  'achieved',
  'missed',
  // payroll periods
  'draft',
  'under_review',
  'approved',
  'finalized',
  'paid',
  'adjusted',
  // stock
  'in_stock',
  'low_stock',
  'out_of_stock',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** The filter fields shared by a report read and an export. */
export class ReportFiltersDto extends PaginationQueryDto {
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  employee_id?: string;

  @IsOptional()
  @IsIn(REPORT_STATUSES, { message: 'invalid' })
  status?: ReportStatus;

  @IsOptional()
  @IsIn(WORK_MODES, { message: 'invalid' })
  work_mode?: (typeof WORK_MODES)[number];

  @IsOptional()
  @IsIn(TASK_PRIORITIES, { message: 'invalid' })
  priority?: (typeof TASK_PRIORITIES)[number];

  @IsOptional()
  @IsIn(GOAL_TYPES, { message: 'invalid' })
  goal_type?: (typeof GOAL_TYPES)[number];

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  warehouse_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  category_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  product_id?: string;

  @IsOptional()
  @IsIn(PRODUCT_STATUSES, { message: 'invalid' })
  product_status?: (typeof PRODUCT_STATUSES)[number];

  @IsOptional()
  @IsIn(MOVEMENT_TYPES, { message: 'invalid' })
  movement_type?: (typeof MOVEMENT_TYPES)[number];

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  user_id?: string;
}

/** `GET /reports/{key}` — `confirm_large_range=true` runs a range longer than 12 months. */
export class ReportQueryDto extends ReportFiltersDto {
  @IsOptional()
  @IsIn(['true', 'false'], { message: 'invalid' })
  confirm_large_range?: 'true' | 'false';
}

export const EXPORT_FORMATS = ['csv'] as const;

/**
 * `POST /reports/{key}/export` — the same filters as the report, in the body.
 * CSV is the V1 format (DOCUMENT 18 "Export & print"); `page`/`per_page` are
 * not export fields — an export holds every permitted row.
 */
export class ExportReportDto extends ReportFiltersDto {
  @IsIn(EXPORT_FORMATS, { message: 'invalid' })
  format!: (typeof EXPORT_FORMATS)[number];

  @IsOptional()
  @IsBoolean({ message: 'invalid' })
  confirm_large_range?: boolean;
}

/** A calendar month on the wire: `YYYY-MM`. */
export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `GET /reports/employee/{id}/monthly?month=YYYY-MM`. */
export class MonthlyReportQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(MONTH_KEY, { message: 'invalid' })
  month!: string;
}

/** The route's `{id}/monthly/{year}/{month}` for generation and regeneration. */
export class MonthlyReportParamsDto {
  @IsUUID(undefined, { message: 'invalid' })
  id!: string;

  @NumericInput()
  @IsInt({ message: 'invalid' })
  @Min(2000, { message: 'invalid' })
  @Max(2999, { message: 'invalid' })
  year!: number;

  @NumericInput()
  @IsInt({ message: 'invalid' })
  @Min(1, { message: 'invalid' })
  @Max(12, { message: 'invalid' })
  month!: number;
}
