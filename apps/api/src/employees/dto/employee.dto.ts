/**
 * `/employees` request shapes — DOCUMENT 08 §4.3, DOCUMENT 06 §3.6.
 *
 * What is here is the DOCUMENT 08 §4.3 `POST /employees` body minus
 * `monthly_salary` and `leave_allowances`, which are deferred to Phases 11
 * and 10 by approved decision. `status` and `termination_date` are not
 * writable: status changes only through `/deactivate` and `/activate`, which is
 * the only lifecycle DOCUMENT 08 defines. `photo_path` is not writable either —
 * a photo is an attachment (DOCUMENT 08 §4.14), which no phase has built yet.
 *
 * `company_id` is never a field (DOCUMENT 08 §1's critical rule); the
 * whitelist turns an attempt to send one into a 422.
 */

import { ASSIGNABLE_ROLE_KEYS } from '@ufuq/auth';
import type { AssignableRoleKey } from '@ufuq/auth';
import { normaliseDigits } from '@ufuq/i18n';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NoControlCharacters,
  TrimmedText,
} from '../../company-structure/validation.js';

/** VARCHAR lengths — DOCUMENT 06 §3.6 and the Phase 5 migration. */
export const EMPLOYEE_NAME_MAX_LENGTH = 100;
export const EMPLOYEE_CODE_MAX_LENGTH = 50;
export const EMAIL_MAX_LENGTH = 255;
export const PHONE_MAX_LENGTH = 32;
export const DEACTIVATION_REASON_MAX_LENGTH = 500;
export const SEARCH_MAX_LENGTH = 100;

/** DOCUMENT 06 §3.6 — the whole set. */
export const EMPLOYEE_STATUSES = ['active', 'inactive', 'terminated'] as const;
export type EmployeeStatusValue = (typeof EMPLOYEE_STATUSES)[number];

/** DOCUMENT 08 §4.3: "sort: name, joining_date, department". */
export const EMPLOYEE_SORTS = ['name', 'joining_date', 'department'] as const;
export type EmployeeSort = (typeof EMPLOYEE_SORTS)[number];

/** DOCUMENT 08 §1: `order=asc|desc`. */
export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Digits, spaces, dashes and an optional leading `+`. Arabic-Indic digits are
 * normalised first (DOCUMENT 08 §5.5), so `+٢٠١٠…` is accepted as `+2010…`.
 */
const PHONE_PATTERN = /^\+?[0-9][0-9 -]{2,30}$/;

/**
 * Stored lowercased: login looks the address up exactly as `POST /auth/login`
 * normalises it (`LoginDto`), and `(company_id, email)` must not hold two
 * spellings of one mailbox.
 */
function EmailInput(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
}

function PhoneInput(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

function SearchInput(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

export class CreateEmployeeDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  @NoControlCharacters()
  first_name!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  @NoControlCharacters()
  last_name!: string;

  /** Required by approved Phase 5 decision: every employee gets a login user (FLOW 02). */
  @EmailInput()
  @IsEmail({}, { message: 'invalid' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @IsOptional()
  @PhoneInput()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'invalid' })
  @MaxLength(PHONE_MAX_LENGTH)
  phone?: string | null;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_CODE_MAX_LENGTH)
  @NoControlCharacters()
  employee_code!: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  position_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  manager_id?: string | null;

  /** NOT NULL in DOCUMENT 06 §3.6. */
  @IsUUID(undefined, { message: 'invalid' })
  work_schedule_id!: string;

  /** A real calendar date — approved Phase 5 decision: no future-date limit. */
  @TrimmedText()
  @IsString()
  @IsCalendarDate({ message: 'invalid' })
  joining_date!: string;

  @IsIn(ASSIGNABLE_ROLE_KEYS, { message: 'invalid' })
  role_key!: AssignableRoleKey;

  @IsBoolean({ message: 'invalid' })
  send_invitation!: boolean;
}

/**
 * Every field optional. A key that is absent means "leave it alone"; for the
 * nullable references, an explicit `null` means "clear it". For the columns
 * that cannot be null, `ValidateIf` runs the validators whenever the key is
 * present, so an explicit `null` is refused rather than slipping past
 * `@IsOptional()`.
 */
export class UpdateEmployeeDto {
  @ValidateIf((dto: UpdateEmployeeDto) => dto.first_name !== undefined)
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  @NoControlCharacters()
  first_name?: string;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.last_name !== undefined)
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_NAME_MAX_LENGTH)
  @NoControlCharacters()
  last_name?: string;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.email !== undefined)
  @EmailInput()
  @IsEmail({}, { message: 'invalid' })
  @MaxLength(EMAIL_MAX_LENGTH)
  email?: string;

  @IsOptional()
  @PhoneInput()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'invalid' })
  @MaxLength(PHONE_MAX_LENGTH)
  phone?: string | null;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.employee_code !== undefined)
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_CODE_MAX_LENGTH)
  @NoControlCharacters()
  employee_code?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  position_id?: string | null;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  manager_id?: string | null;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.work_schedule_id !== undefined)
  @IsUUID(undefined, { message: 'invalid' })
  work_schedule_id?: string;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.joining_date !== undefined)
  @TrimmedText()
  @IsString()
  @IsCalendarDate({ message: 'invalid' })
  joining_date?: string;

  @ValidateIf((dto: UpdateEmployeeDto) => dto.role_key !== undefined)
  @IsIn(ASSIGNABLE_ROLE_KEYS, { message: 'invalid' })
  role_key?: AssignableRoleKey;
}

/** `POST /employees/{id}/deactivate` — DOCUMENT 08 §4.3: "reason required". */
export class DeactivateEmployeeDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(DEACTIVATION_REASON_MAX_LENGTH)
  @NoControlCharacters()
  reason!: string;
}

/**
 * `GET /employees` — DOCUMENT 08 §4.3: filters `department_id`, `position_id`,
 * `status`, `manager_id`; search on name, code and email; sort on name,
 * joining date and department. An unknown sort key is a 422 (DOCUMENT 26 §3:
 * "sort whitelist rejection").
 */
export class ListEmployeesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  department_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  position_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  manager_id?: string;

  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES, { message: 'invalid' })
  status?: EmployeeStatusValue;

  @IsOptional()
  @SearchInput()
  @IsString()
  @MaxLength(SEARCH_MAX_LENGTH)
  @NoControlCharacters()
  search?: string;

  @IsOptional()
  @IsIn(EMPLOYEE_SORTS, { message: 'invalid' })
  sort?: EmployeeSort;

  @IsOptional()
  @IsIn(SORT_ORDERS, { message: 'invalid' })
  order?: SortOrder;
}
