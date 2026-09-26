/**
 * `POST /holidays` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.9, DOCUMENT 12.
 *
 * DOCUMENT 08 §4.2 lists `GET` and `POST` and no `/{id}` row, so there is no
 * update or delete DTO — and `holidays` has no `deleted_at` column in
 * DOCUMENT 06 §3.9 either. See docs/PHASE-4-STATUS.md.
 */

import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import {
  IsCalendarDate,
  NAME_MAX_LENGTH,
  NoControlCharacters,
  TrimmedText,
} from '../validation.js';

export class CreateHolidayDto {
  /** `YYYY-MM-DD`. A DATE column — a holiday has no time of day. */
  @TrimmedText()
  @IsString()
  @IsCalendarDate()
  date!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name_ar!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name_en!: string;

  @IsOptional()
  @IsBoolean()
  is_recurring?: boolean;
}
