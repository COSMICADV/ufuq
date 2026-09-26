/**
 * `POST /work-schedules`, `PATCH /work-schedules/{id}` — DOCUMENT 08 §4.2,
 * DOCUMENT 06 §3.7–3.8, DOCUMENT 12.
 *
 * This is the DTO DOCUMENT 27 RULE 12 exists for. Every value a later phase
 * needs in order to decide whether someone was late, worked a half day, or
 * earned overtime is a required field here — none of it has a code-level
 * default, and `days` must describe all seven weekdays explicitly. A schedule
 * that only listed its working days would leave the rest undefined, and an
 * undefined day is what tempts a calculation engine to assume one.
 */

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  DecimalInput,
  IsDecimalHours,
  IsIanaTimeZone,
  NAME_MAX_LENGTH,
  NoControlCharacters,
  NumericInput,
  TIMEZONE_MAX_LENGTH,
  TIME_OF_DAY,
  TrimmedText,
} from '../validation.js';

/** DOCUMENT 06 §3.7 — the whole set. */
export const OVERTIME_POLICIES = ['none', 'paid', 'banked'] as const;
export type OvertimePolicyValue = (typeof OVERTIME_POLICIES)[number];

/** DOCUMENT 06 §3.8: `day_of_week` SMALLINT (0–6), one row per weekday. */
export const DAYS_IN_WEEK = 7;

/**
 * A minute count that has to fit inside the day it describes. Matches the
 * CHECK constraints in the Phase 4 migration, so the same value is refused by
 * the validator and by the database rather than only by whichever runs first.
 */
export const MINUTES_IN_DAY = 1440;

export class WorkScheduleDayDto {
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(DAYS_IN_WEEK - 1)
  day_of_week!: number;

  @IsBoolean()
  is_working_day!: boolean;

  /** Required when `is_working_day`, forbidden when not — enforced in the service. */
  @IsOptional()
  @TrimmedText()
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'invalid' })
  start_time?: string | null;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @Matches(TIME_OF_DAY, { message: 'invalid' })
  end_time?: string | null;
}

export class CreateWorkScheduleDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name!: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @TrimmedText()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  timezone!: string;

  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  grace_period_minutes!: number;

  /**
   * A string, not a number: DECIMAL(4,2) values do not survive a round trip
   * through binary floating point unscathed as a class of values, and this
   * codebase does not make an exception for the ones that happen to
   * (DOCUMENT 27 RULE 17).
   */
  @DecimalInput()
  @IsDecimalHours({ min: '0.00', max: '24.00' }, { message: 'invalid' })
  half_day_threshold_hours!: string;

  @IsIn(OVERTIME_POLICIES)
  overtime_policy!: OvertimePolicyValue;

  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  break_minutes!: number;

  @IsArray()
  @ArrayMinSize(DAYS_IN_WEEK)
  @ArrayMaxSize(DAYS_IN_WEEK)
  @ValidateNested({ each: true })
  @Type(() => WorkScheduleDayDto)
  days!: WorkScheduleDayDto[];
}

/**
 * Every field optional — a PATCH may change the grace period without
 * restating the week. When `days` *is* present it replaces the whole week,
 * because a partial week is exactly the undefined state this model refuses.
 */
export class UpdateWorkScheduleDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  timezone?: string;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  grace_period_minutes?: number;

  @IsOptional()
  @DecimalInput()
  @IsDecimalHours({ min: '0.00', max: '24.00' }, { message: 'invalid' })
  half_day_threshold_hours?: string;

  @IsOptional()
  @IsIn(OVERTIME_POLICIES)
  overtime_policy?: OvertimePolicyValue;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  break_minutes?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(DAYS_IN_WEEK)
  @ArrayMaxSize(DAYS_IN_WEEK)
  @ValidateNested({ each: true })
  @Type(() => WorkScheduleDayDto)
  days?: WorkScheduleDayDto[];
}
