/**
 * Leave request shapes — DOCUMENT 08 §4.2 (`/leave-types`) and §4.6
 * (`/leave-requests`, `/leave-balances`), DOCUMENT 16 "Validation".
 *
 * What is deliberately not writable: `days_count` (rule 2 — the server
 * calculates it; the employee never types it), `employee_id` on submission
 * (`leave.request` is `self` for every role), `status`, the reviewer, the
 * balance's `used_days` / `pending_days` (they follow requests, never a
 * form), and `company_id`, ever (DOCUMENT 08 §1).
 */

import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
} from 'class-validator';
import type { ValidationOptions } from 'class-validator';
import { normaliseDigits } from '@ufuq/i18n';
import { Decimal, DecimalError } from '@ufuq/money';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NoControlCharacters,
  NumericInput,
  TrimmedText,
} from '../../company-structure/validation.js';
import {
  CARRY_OVER_POLICIES,
  DAYS_SCALE,
  LEAVE_REQUEST_STATUSES,
  NOTE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
} from '../leave-rules.js';
import type { CarryOverPolicyValue, LeaveRequestStatusValue } from '../leave-rules.js';

/** DECIMAL(5,2) day counts travel as strings, never JSON numbers (DOCUMENT 08 §1). */
function DayString(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

function IsDays(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isDays',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string') return false;
          try {
            const parsed = Decimal.parse(value, DAYS_SCALE);
            // DECIMAL(5,2): at most 999.99, never negative.
            return !parsed.isNegative() && parsed.compare(Decimal.parse('999.99', DAYS_SCALE)) <= 0;
          } catch (error) {
            if (error instanceof DecimalError) return false;
            throw error;
          }
        },
        defaultMessage: () => 'invalid',
      },
    });
  };
}

// -- Leave types --------------------------------------------------------------

export class CreateLeaveTypeDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NoControlCharacters({ message: 'name_ar must not contain control characters' })
  name_ar!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NoControlCharacters({ message: 'name_en must not contain control characters' })
  name_en!: string;

  @IsBoolean()
  is_paid!: boolean;

  @DayString()
  @IsDays()
  default_days_per_year!: string;

  @IsBoolean()
  requires_attachment!: boolean;

  @IsBoolean()
  allows_negative_balance!: boolean;

  @IsIn(CARRY_OVER_POLICIES)
  carry_over_policy!: CarryOverPolicyValue;

  /** Required exactly when the policy is `capped`. */
  @IsOptional()
  @DayString()
  @IsDays()
  carry_over_cap?: string | null;
}

export class UpdateLeaveTypeDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NoControlCharacters({ message: 'name_ar must not contain control characters' })
  name_ar?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NoControlCharacters({ message: 'name_en must not contain control characters' })
  name_en?: string;

  @IsOptional()
  @IsBoolean()
  is_paid?: boolean;

  @IsOptional()
  @DayString()
  @IsDays()
  default_days_per_year?: string;

  @IsOptional()
  @IsBoolean()
  requires_attachment?: boolean;

  @IsOptional()
  @IsBoolean()
  allows_negative_balance?: boolean;

  @IsOptional()
  @IsIn(CARRY_OVER_POLICIES)
  carry_over_policy?: CarryOverPolicyValue;

  @IsOptional()
  @DayString()
  @IsDays()
  carry_over_cap?: string | null;
}

// -- Leave requests -----------------------------------------------------------

/**
 * POST /leave-requests. JSON, or multipart when a file is attached (the part
 * named `file`; DOCUMENT 16 rule 9 — the attachment is checked with the
 * submission it belongs to).
 */
export class CreateLeaveRequestDto {
  @IsUUID()
  leave_type_id!: string;

  @IsCalendarDate()
  start_date!: string;

  @IsCalendarDate()
  end_date!: string;

  @TrimmedText()
  @IsString()
  @MinLength(REASON_MIN_LENGTH)
  @MaxLength(REASON_MAX_LENGTH)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;
}

/** GET /leave-requests/calculate — DOCUMENT 08 §4.6. */
export class CalculateLeaveQueryDto {
  @IsCalendarDate()
  start_date!: string;

  @IsCalendarDate()
  end_date!: string;

  /** With a type, the answer includes the balance impact. */
  @IsOptional()
  @IsUUID()
  leave_type_id?: string;
}

/** GET /leave-requests — DOCUMENT 08 §4.6: status, leave_type_id, employee_id, date range. */
export class ListLeaveRequestsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: LeaveRequestStatusValue;

  @IsOptional()
  @IsUUID()
  leave_type_id?: string;

  @IsOptional()
  @IsUUID()
  employee_id?: string;

  /** Leave that ends on or after this day. */
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  /** Leave that starts on or before this day. */
  @IsOptional()
  @IsCalendarDate()
  to?: string;
}

export class ApproveLeaveDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  @NoControlCharacters({ message: 'review_note must not contain control characters' })
  review_note?: string;
}

/** DOCUMENT 16 rule 8: "Rejection requires a reason". */
export class RejectLeaveDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_MAX_LENGTH)
  @NoControlCharacters({ message: 'review_note must not contain control characters' })
  review_note!: string;
}

/**
 * POST /leave-requests/{id}/cancel. The requester withdrawing their own
 * pending request needs no reason; an ADMIN cancelling approved leave
 * (DOCUMENT 16 rule 15) must give one.
 */
export class CancelLeaveDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_MAX_LENGTH)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason?: string;
}

// -- Leave balances -----------------------------------------------------------

export class ListLeaveBalancesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  employee_id?: string;

  @IsOptional()
  @IsUUID()
  leave_type_id?: string;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(2000)
  @Max(2999)
  year?: number;
}

export class MyLeaveBalancesQueryDto {
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(2000)
  @Max(2999)
  year?: number;
}

/**
 * PATCH /leave-balances/{id} — DOCUMENT 16 rule 14: an entitlement change
 * with a reason. Only the entitlement (`total_days`, `carried_over_days`) is
 * adjustable; `used_days` and `pending_days` are history that follows the
 * requests themselves.
 */
export class AdjustLeaveBalanceDto {
  @IsOptional()
  @DayString()
  @IsDays()
  total_days?: string;

  @IsOptional()
  @DayString()
  @IsDays()
  carried_over_days?: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_MAX_LENGTH)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;
}
