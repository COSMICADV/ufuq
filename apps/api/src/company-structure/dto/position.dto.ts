/**
 * `POST /positions` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.5.
 *
 * DOCUMENT 08 §4.2 lists `GET` and `POST` for this resource and no `/{id}`
 * row, so no update or delete DTO exists here. See docs/PHASE-4-STATUS.md —
 * DOCUMENT 04 B25 calls the positions screen a "CRUD list", which is a
 * documented contradiction rather than something to resolve by writing the
 * extra endpoints (DOCUMENT 27 RULES 2 and 35).
 */

import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { NAME_MAX_LENGTH, NoControlCharacters, TrimmedText } from '../validation.js';

export class CreatePositionDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  title_ar!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  title_en!: string;

  /** Nullable in DOCUMENT 06 §3.5 — a position need not belong to a department. */
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string | null;
}
