/**
 * `POST /departments`, `PATCH /departments/{id}` — DOCUMENT 08 §4.2,
 * DOCUMENT 06 §3.4.
 *
 * `manager_employee_id` arrived in Phase 5 (approved Phase 4 decision), once
 * `employees` existed for it to reference. `status` carries the two approved
 * values and no others.
 *
 * On the PATCH, an omitted key means "leave this alone" and an explicit
 * `null` on `parent_id` or `manager_employee_id` means "clear it". The two are
 * told apart by `undefined` versus `null`, which `@IsOptional()` lets through
 * untouched.
 */

import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

import { NAME_MAX_LENGTH, NoControlCharacters, TrimmedText } from '../validation.js';

/** DOCUMENT 06 §3.4 — the whole set. */
export const DEPARTMENT_STATUSES = ['active', 'inactive'] as const;
export type DepartmentStatusValue = (typeof DEPARTMENT_STATUSES)[number];

export class CreateDepartmentDto {
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
  @IsUUID(undefined, { message: 'invalid' })
  parent_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  manager_employee_id?: string | null;

  @IsOptional()
  @IsIn(DEPARTMENT_STATUSES)
  status?: DepartmentStatusValue;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name_ar?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name_en?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  parent_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  manager_employee_id?: string | null;

  @IsOptional()
  @IsIn(DEPARTMENT_STATUSES)
  status?: DepartmentStatusValue;
}
