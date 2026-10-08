/**
 * `/goals` request shapes — DOCUMENT 08 §4.8, DOCUMENT 14 "Validation",
 * DOCUMENT 08 §5.
 *
 * What is deliberately not writable:
 *
 *   - `current_value` and `status`, ever. The value changes only through
 *     `POST /goals/{id}/progress` (Sales, Custom) or by derivation from tasks
 *     (Task); the status follows value and period (DOCUMENT 14 rule 7). The
 *     whitelist turns an attempt to send either into a 422.
 *   - `employee_id` and `type` after creation — "the goal stays with the
 *     employee" (DOCUMENT 14 edge cases), and a type decides where the value
 *     comes from.
 *   - `company_id`, ever (DOCUMENT 08 §1's critical rule).
 */

import { Transform } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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
  TrimmedText,
} from '../../company-structure/validation.js';
import { GOAL_STATUSES, GOAL_TYPES, VALUE_SCALE } from '../goal-rules.js';
import type { GoalStatusValue, GoalTypeValue } from '../goal-rules.js';

/** VARCHAR(255), as for task titles. DOCUMENT 14 sets no minimum beyond "present". */
export const GOAL_TITLE_MAX_LENGTH = 255;
/** TEXT with a bound, the same reasoning as task descriptions (Phase 7). */
export const GOAL_DESCRIPTION_MAX_LENGTH = 5000;
/** DOCUMENT 06 §3.18: `unit` VARCHAR(20). */
export const GOAL_UNIT_MAX_LENGTH = 20;
/** The `goal_progress_note_length` CHECK. */
export const PROGRESS_NOTE_MAX_LENGTH = 1000;

/** Digits normalised, value kept as a string (DOCUMENT 08 §5.5, RULE 17). */
function DecimalString(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

/**
 * A DECIMAL(15,2) value carried as a string — never a JSON number, which has
 * already lost precision before validation could see it (DOCUMENT 08 §1,
 * DOCUMENT 27 RULE 17). `positive` is DOCUMENT 14's "`target_value` > 0";
 * otherwise the value must be non-negative ("Progress value must be numeric
 * and non-negative"). `@ufuq/money`'s parser is the one definition of a
 * valid decimal, and it refuses more than two places rather than rounding.
 */
function IsGoalValue(positive: boolean, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isGoalValue',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'string') {
            return false;
          }
          try {
            const parsed = Decimal.parse(value, VALUE_SCALE);
            return positive ? parsed.isPositive() : !parsed.isNegative();
          } catch (error) {
            if (error instanceof DecimalError) {
              return false;
            }
            throw error;
          }
        },
        defaultMessage: () => 'invalid',
      },
    });
  };
}

/** POST /goals — DOCUMENT 05 FLOW 12, DOCUMENT 04 B11 create form. */
export class CreateGoalDto {
  @IsUUID(undefined, { message: 'invalid' })
  employee_id!: string;

  @IsIn(GOAL_TYPES)
  type!: GoalTypeValue;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(GOAL_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(GOAL_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @DecimalString()
  @IsGoalValue(true)
  target_value!: string;

  /** Required for Custom; Sales defaults to the company currency; Task goals count `tasks`. */
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(GOAL_UNIT_MAX_LENGTH)
  @NoControlCharacters()
  unit?: string;

  @IsCalendarDate({ message: 'invalid' })
  period_start!: string;

  @IsCalendarDate({ message: 'invalid' })
  period_end!: string;

  /** Task goals only — validated against `parseTaskCountRule`. */
  @IsOptional()
  @IsObject()
  task_count_rule?: Record<string, unknown>;
}

/** PATCH /goals/{id} — "Edit" (DOCUMENT 14 "Actions"). */
export class UpdateGoalDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(GOAL_TITLE_MAX_LENGTH)
  @NoControlCharacters()
  title?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(GOAL_DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  /** DOCUMENT 14 edge case "Target changed mid-period": allowed and audited. */
  @IsOptional()
  @DecimalString()
  @IsGoalValue(true)
  target_value?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(GOAL_UNIT_MAX_LENGTH)
  @NoControlCharacters()
  unit?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  period_start?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'invalid' })
  period_end?: string;

  @IsOptional()
  @IsObject()
  task_count_rule?: Record<string, unknown>;
}

/** POST /goals/{id}/progress — DOCUMENT 05 FLOW 13: "new current value + optional note". */
export class CreateGoalProgressDto {
  @DecimalString()
  @IsGoalValue(false)
  value!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(PROGRESS_NOTE_MAX_LENGTH)
  note?: string;
}

/**
 * GET /goals. DOCUMENT 08 §4.8 lists no filters; these three are what the
 * documented screens need — the profile Goals tab (one employee), and the
 * admin list and dashboard widget (type, status). The order is fixed (nearest
 * period end first).
 */
export class ListGoalsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  employee_id?: string;

  @IsOptional()
  @IsIn(GOAL_TYPES)
  type?: GoalTypeValue;

  @IsOptional()
  @IsIn(GOAL_STATUSES)
  status?: GoalStatusValue;
}

/** GET /goals/{id}/progress — DOCUMENT 08 §1 pagination only. */
export class GoalProgressQueryDto extends PaginationQueryDto {}
