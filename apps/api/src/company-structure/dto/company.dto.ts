/**
 * `PATCH /company` — DOCUMENT 08 §4.2.
 *
 * Six editable fields, by the approved Phase 4 decision: name, logo, timezone,
 * currency, locale, fiscal-month start day. `slug` and `status` are columns on
 * the same table and are deliberately absent — a tenant renaming its own slug
 * or activating its own suspended account are not settings, and adding them
 * "because the column is there" is DOCUMENT 27 RULE 2.
 *
 * `company_id` is not a field here and never will be: DOCUMENT 08 §1's
 * critical rule. The whitelist in `createValidationPipe` turns any attempt to
 * send one into a 422 rather than a silently ignored key.
 */

import { LOCALES } from '@ufuq/i18n';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  IsIanaTimeZone,
  NAME_MAX_LENGTH,
  NoControlCharacters,
  NumericInput,
  TIMEZONE_MAX_LENGTH,
  TrimmedText,
} from '../validation.js';

/**
 * DOCUMENT 06 §3.1 gives `fiscal_month_start_day` a SMALLINT column and a
 * default of 1, but no range. 1–28 is the only range that names a day
 * existing in every month; 29–31 would need a documented rule for February
 * that no document in the package states, and inventing one here would be
 * inventing a workflow. Widening the bound later is additive.
 */
export const FISCAL_MONTH_START_DAY_MIN = 1;
export const FISCAL_MONTH_START_DAY_MAX = 28;

/** Matches `companies_correction_window_days_min` (DOCUMENT 12 rule 13). */
export const CORRECTION_WINDOW_DAYS_MIN = 1;

/**
 * Not a policy — DOCUMENT 12 gives the window no maximum, and neither does
 * the database. This is the largest value the SMALLINT column can store; above
 * it the write would fail in PostgreSQL and surface as a 500 rather than as the
 * validation error it is.
 */
export const CORRECTION_WINDOW_DAYS_STORAGE_MAX = 32_767;

export class UpdateCompanyDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name?: string;

  /**
   * Nullable in DOCUMENT 06 §3.1, so `null` is a meaningful value here —
   * "remove the logo" — and is distinct from the key being absent.
   * The file itself is an attachment (DOCUMENT 08 §4.14, a later phase);
   * this column holds the stored path.
   */
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @NoControlCharacters()
  logo_path?: string | null;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(TIMEZONE_MAX_LENGTH)
  @IsIanaTimeZone()
  timezone?: string;

  /** ISO 4217 alphabetic, CHAR(3). Uppercased so `egp` and `EGP` are one value. */
  @IsOptional()
  @TrimmedText()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @IsOptional()
  @TrimmedText()
  @IsIn(LOCALES)
  default_locale?: (typeof LOCALES)[number];

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(FISCAL_MONTH_START_DAY_MIN)
  @Max(FISCAL_MONTH_START_DAY_MAX)
  fiscal_month_start_day?: number;

  /**
   * DOCUMENT 12 rule 13 — "corrections have a window, default 7 days,
   * configurable per company".
   *
   * The minimum matches the CHECK constraint on the column, so the same value
   * is refused by the validator and by the database rather than only by
   * whichever runs first. Zero is excluded deliberately: a window of zero days
   * is not a configuration, it is switching off the flow DOCUMENT 12 rule 14
   * depends on. There is no documented maximum; see
   * {@link CORRECTION_WINDOW_DAYS_STORAGE_MAX} for the only ceiling.
   */
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(CORRECTION_WINDOW_DAYS_MIN)
  @Max(CORRECTION_WINDOW_DAYS_STORAGE_MAX)
  correction_window_days?: number;
}
