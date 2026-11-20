/**
 * `/personal/finance/budgets` request shapes. Amounts are DECIMAL(15,2)
 * strings; months are `YYYY-MM`, days `YYYY-MM-DD`.
 */

import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

import { IsCalendarDate, NoControlCharacters, TrimmedText } from '../company-structure/validation.js';
import { DecimalString, IsAmount } from '../payroll/dto/payroll.dto.js';

import { ALERT_CHOICES } from './budget-rules.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CURRENCY = /^[A-Z]{3}$/;

export class CreateBudgetDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(80)
  @NoControlCharacters()
  name?: string;

  /** Omitted for an overall budget over all expenses. */
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsIn(['monthly', 'custom'])
  period!: 'monthly' | 'custom';

  @DecimalString()
  @IsAmount('positive')
  amount!: string;

  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  /** Monthly: the first month it applies (default: this month). */
  @IsOptional()
  @Matches(MONTH)
  start_month?: string;

  /** Custom: the first and last day, inclusive. */
  @IsOptional()
  @IsCalendarDate()
  start_date?: string;

  @IsOptional()
  @IsCalendarDate()
  end_date?: string;

  @IsOptional()
  @IsBoolean()
  rollover?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsInt({ each: true })
  @IsIn(ALERT_CHOICES, { each: true })
  alert_thresholds?: number[];
}

export class UpdateBudgetDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(80)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('positive')
  amount?: string;

  @IsOptional()
  @IsCalendarDate()
  start_date?: string;

  @IsOptional()
  @IsCalendarDate()
  end_date?: string;

  @IsOptional()
  @IsBoolean()
  rollover?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @IsInt({ each: true })
  @IsIn(ALERT_CHOICES, { each: true })
  alert_thresholds?: number[];
}

export class BudgetsQueryDto {
  /** The month to measure monthly budgets in (default: this month). */
  @IsOptional()
  @Matches(MONTH)
  month?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: string;
}
