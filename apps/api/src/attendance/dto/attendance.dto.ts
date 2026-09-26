/**
 * Attendance request bodies and query strings — DOCUMENT 08 §4.4–4.5, §5.
 *
 * DOCUMENT 12 "Clock skew": **no endpoint here accepts a timestamp for `now`.**
 * Check-in and check-out carry no time at all; the server's clock is the only
 * one. The only timestamps a client may send are the ones on a *correction*,
 * which is a claim about the past that a reviewer then has to approve.
 */

import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  IsCalendarDate,
  NoControlCharacters,
  TrimmedText,
} from '../../company-structure/validation.js';
import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';

export const WORK_MODES = ['office', 'wfh'] as const;
export type WorkModeValue = (typeof WORK_MODES)[number];

export const ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'late',
  'on_leave',
  'half_day',
  'holiday',
  'weekend',
  'pending',
] as const;

/** DOCUMENT 12 "REASON" fields — long enough to explain, bounded so TEXT is not a hole. */
export const REASON_MAX_LENGTH = 1000;
export const NOTE_MAX_LENGTH = 1000;

export class CheckInDto {
  /** DOCUMENT 12 rule 2 — required, with no default. */
  @IsIn(WORK_MODES)
  work_mode!: WorkModeValue;

  /**
   * DOCUMENT 12 "ERROR STATES": checking in on a rest day is refused once with
   * `NON_WORKING_DAY` and allowed when the employee confirms. The flag is the
   * confirmation, which is why it is not simply ignored when false.
   */
  @IsOptional()
  @IsBoolean()
  confirm_non_working_day?: boolean;
}

export class AttendanceListQueryDto extends PaginationQueryDto {
  /** A single day — DOCUMENT 08 §4.4's `?date=`. Mutually exclusive with from/to. */
  @IsOptional()
  @IsCalendarDate()
  date?: string;

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @IsUUID()
  department_id?: string;

  @IsOptional()
  @IsUUID()
  employee_id?: string;

  @IsOptional()
  @IsIn(ATTENDANCE_STATUSES)
  status?: string;

  @IsOptional()
  @IsIn(WORK_MODES)
  work_mode?: string;
}

export class MonthlyQueryDto {
  /** `YYYY-MM` — DOCUMENT 08 §4.4. */
  @IsString()
  @MinLength(7)
  @MaxLength(7)
  month!: string;

  @IsOptional()
  @IsUUID()
  department_id?: string;

  @IsOptional()
  @IsUUID()
  employee_id?: string;
}

/** DOCUMENT 08 §4.3 `GET /employees/{id}/attendance?month=YYYY-MM`. */
export class EmployeeAttendanceQueryDto {
  @IsString()
  @MinLength(7)
  @MaxLength(7)
  month!: string;
}

export class SummaryQueryDto {
  @IsOptional()
  @IsCalendarDate()
  date?: string;
}

/**
 * `PATCH /attendance/{id}` — DOCUMENT 08 §4.4, DOCUMENT 12 rule 11.
 *
 * `reason` is required because DOCUMENT 12 rule 11 requires it, and it is kept
 * in the audit record rather than on the row: DOCUMENT 06 §3.10 gives the
 * table no column for *why* an adjustment happened, and DOCUMENT 21 is where
 * that question belongs. Same reasoning as the Phase 5 deactivation reason.
 */
export class AdjustAttendanceDto {
  @IsOptional()
  @IsIn(WORK_MODES)
  work_mode?: WorkModeValue | null;

  @IsOptional()
  @IsString()
  check_in_at?: string | null;

  @IsOptional()
  @IsString()
  check_out_at?: string | null;

  @IsOptional()
  @IsIn(ATTENDANCE_STATUSES)
  status?: string;

  @IsOptional()
  @TrimmedText()
  @NoControlCharacters({ message: 'note must not contain control characters' })
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string | null;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;
}

/** `POST /attendance-corrections` — DOCUMENT 08 §4.5, DOCUMENT 04 C4. */
export class CreateCorrectionDto {
  @IsCalendarDate()
  date!: string;

  @IsOptional()
  @IsString()
  requested_check_in?: string;

  @IsOptional()
  @IsString()
  requested_check_out?: string;

  @IsOptional()
  @IsIn(WORK_MODES)
  requested_work_mode?: WorkModeValue;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;

  /**
   * An admin or manager may raise a correction on behalf of an employee; an
   * employee holding only `self` scope may not name anyone but themselves, and
   * the service refuses it rather than trusting this field.
   */
  @IsOptional()
  @IsUUID()
  employee_id?: string;
}

export const CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

export class CorrectionListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(CORRECTION_STATUSES)
  status?: string;

  @IsOptional()
  @IsUUID()
  employee_id?: string;

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;
}

export class ApproveCorrectionDto {
  @IsOptional()
  @TrimmedText()
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters({ message: 'review_note must not contain control characters' })
  review_note?: string;
}

/** DOCUMENT 12 validation: "rejection requires a reason". */
export class RejectCorrectionDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters({ message: 'review_note must not contain control characters' })
  review_note!: string;
}
