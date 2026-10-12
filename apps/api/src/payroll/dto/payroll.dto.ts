/**
 * Salary and payroll request shapes — DOCUMENT 08 §4.2 (`/salary-policies`),
 * §4.3 (`/employees/{id}/salary`), §4.10 (`/payroll`), DOCUMENT 15
 * "Validation".
 *
 * Money travels as strings, never JSON numbers (DOCUMENT 08 §1), and is
 * parsed by `@ufuq/money`'s `Decimal`, the one decimal parser in the
 * workspace. Nothing computed is writable: not a net, a total, a status, a
 * creator, or a `company_id` (DOCUMENT 08 §1). The global validation pipe
 * rejects unknown fields.
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
import { ENTRY_REASON_MAX, ENTRY_REASON_MIN, ENTRY_TYPE_MAX } from '../payroll-rules.js';

const MONEY_SCALE = 2;
/** DECIMAL(15,2): thirteen integer digits. */
const MONEY_MAX = '9999999999999.99';
/** DECIMAL(5,2). */
const RATE_MAX = '999.99';

function DecimalString(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

type Sign = 'positive' | 'non_negative' | 'non_zero';

function inRange(value: unknown, sign: Sign, max: string): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = Decimal.parse(value, MONEY_SCALE);
    if (parsed.abs().compare(Decimal.parse(max, MONEY_SCALE)) > 0) return false;
    switch (sign) {
      case 'positive':
        return parsed.isPositive();
      case 'non_negative':
        return !parsed.isNegative();
      case 'non_zero':
        return !parsed.isZero();
    }
  } catch (error) {
    if (error instanceof DecimalError) return false;
    throw error;
  }
}

/** A DECIMAL(15,2) amount, or DECIMAL(5,2) when `max` says so. */
function IsAmount(sign: Sign, max = MONEY_MAX, options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isAmount',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: (value: unknown) => inRange(value, sign, max),
        defaultMessage: () => 'invalid',
      },
    });
  };
}

export const DAILY_WAGE_BASES = ['fixed_days', 'scheduled_working_days', 'calendar_days'] as const;
export const UNPAID_LEAVE_RULES = ['daily_wage', 'scheduled_day_wage', 'none'] as const;
export const ABSENCE_RULES = ['daily_wage', 'none'] as const;
export const ROUNDING_RULES = ['none', 'nearest', 'up', 'down'] as const;
export const LATENESS_TYPES = ['none', 'per_minute', 'fixed_per_incident'] as const;

/**
 * The three V1 lateness rules (approved decision), with exactly their own
 * parameter and nothing else:
 *   {"type":"none"}
 *   {"type":"per_minute","multiplier":"1.00"}        multiplier > 0, DECIMAL(5,2)
 *   {"type":"fixed_per_incident","amount":"50.00"}   amount > 0, DECIMAL(15,2)
 */
export function isLatenessRule(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  const keys = Object.keys(rule).sort();
  switch (rule.type) {
    case 'none':
      return keys.length === 1;
    case 'per_minute':
      return keys.join(',') === 'multiplier,type' && inRange(rule.multiplier, 'positive', RATE_MAX);
    case 'fixed_per_incident':
      return keys.join(',') === 'amount,type' && inRange(rule.amount, 'positive', MONEY_MAX);
    default:
      return false;
  }
}

function IsLatenessRule(options?: ValidationOptions): PropertyDecorator {
  return (target, propertyName) => {
    registerDecorator({
      name: 'isLatenessRule',
      target: target.constructor,
      propertyName: propertyName as string,
      options: options ?? {},
      validator: {
        validate: isLatenessRule,
        defaultMessage: () => 'invalid',
      },
    });
  };
}

/** Digits in a lateness rule's parameter are normalised like any other numeric field. */
function LatenessInput(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        typeof entry === 'string' && key !== 'type' ? normaliseDigits(entry.trim()) : entry;
    }
    return out;
  });
}

// -- Salary policy --------------------------------------------------------------

/**
 * PATCH /salary-policies — the company's one policy. The first save must give
 * every field (no default is invented — approved decision); later saves may
 * give any subset. Cross-field rules (the fixed divisor exists exactly for
 * `fixed_days`) are checked by the service on the merged result.
 */
export class UpdateSalaryPolicyDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @NoControlCharacters({ message: 'name must not contain control characters' })
  name?: string;

  @IsOptional()
  @IsIn(DAILY_WAGE_BASES)
  daily_wage_basis?: (typeof DAILY_WAGE_BASES)[number];

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1)
  @Max(31)
  fixed_days_value?: number | null;

  @IsOptional()
  @IsIn(UNPAID_LEAVE_RULES)
  unpaid_leave_deduction?: (typeof UNPAID_LEAVE_RULES)[number];

  @IsOptional()
  @IsIn(ABSENCE_RULES)
  absence_deduction?: (typeof ABSENCE_RULES)[number];

  @IsOptional()
  @LatenessInput()
  @IsLatenessRule()
  lateness_rule?: Record<string, string>;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative', RATE_MAX)
  overtime_rate?: string;

  @IsOptional()
  @IsIn(ROUNDING_RULES)
  rounding?: (typeof ROUNDING_RULES)[number];
}

// -- Employee salary -------------------------------------------------------------

/** POST /employees/{id}/salary — closes the current row and inserts this one. */
export class SetSalaryDto {
  @DecimalString()
  @IsAmount('positive')
  monthly_salary!: string;

  @IsCalendarDate()
  effective_from!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(ENTRY_REASON_MAX)
  @NoControlCharacters({ message: 'note must not contain control characters' })
  note?: string;
}

// -- Payroll periods --------------------------------------------------------------

export class GeneratePayrollDto {
  @NumericInput()
  @IsInt()
  @Min(2000)
  @Max(2999)
  year!: number;

  @NumericInput()
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  /**
   * DOCUMENT 15 "Incomplete attendance": the Admin may proceed knowingly.
   * Without it, incomplete attendance is a 409 listing employees and dates.
   */
  @IsOptional()
  @IsBoolean()
  proceed_with_warnings?: boolean;
}

export class PreflightQueryDto {
  @NumericInput()
  @IsInt()
  @Min(2000)
  @Max(2999)
  year!: number;

  @NumericInput()
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;
}

export class RecalculatePayrollDto {
  @IsOptional()
  @IsBoolean()
  proceed_with_warnings?: boolean;
}

/** DOCUMENT 08 §4.10: `{ "confirm": "2026-09" }` — the period, typed. */
export class FinalizePayrollDto {
  @IsString()
  @MaxLength(7)
  confirm!: string;
}

export class ListPayrollPeriodsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(2000)
  @Max(2999)
  year?: number;
}

export class ListPayrollLinesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  employee_id?: string;
}

// -- Entries ------------------------------------------------------------------------

/** POST /payroll/lines/{id}/deductions and /bonuses — DOCUMENT 15 "Validation". */
export class CreatePayrollEntryDto {
  @DecimalString()
  @IsAmount('positive')
  amount!: string;

  @TrimmedText()
  @IsString()
  @MinLength(ENTRY_REASON_MIN)
  @MaxLength(ENTRY_REASON_MAX)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(ENTRY_TYPE_MAX)
  @NoControlCharacters({ message: 'type must not contain control characters' })
  type?: string;
}

/** POST /payroll/lines/{id}/adjustments — a signed amount, never zero, with a reason. */
export class CreatePayrollAdjustmentDto {
  @DecimalString()
  @IsAmount('non_zero')
  amount!: string;

  @TrimmedText()
  @IsString()
  @MinLength(ENTRY_REASON_MIN)
  @MaxLength(ENTRY_REASON_MAX)
  @NoControlCharacters({ message: 'reason must not contain control characters' })
  reason!: string;
}
