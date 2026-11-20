/**
 * `/personal/finance` request shapes. Amounts are DECIMAL(15,2) strings,
 * parsed by `@ufuq/money` and never by `Number`. `company_id` and `user_id`
 * are never accepted: they come from the session.
 */

import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PaginationQueryDto } from '../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NoControlCharacters,
  NumericInput,
  TrimmedText,
} from '../company-structure/validation.js';
import { DecimalString, IsAmount } from '../payroll/dto/payroll.dto.js';

import { ACCOUNT_TYPES, PERIODS, TRANSACTION_TYPES } from './finance-rules.js';
import type { AccountTypeValue, PeriodValue, TransactionTypeValue } from './finance-rules.js';

const CURRENCY = /^[A-Z]{3}$/;

export class CreateAccountDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoControlCharacters()
  name!: string;

  @IsIn(ACCOUNT_TYPES)
  type!: AccountTypeValue;

  @IsOptional()
  @IsString()
  @Matches(CURRENCY)
  currency?: string;

  /** May be negative: a credit card that already owes money. */
  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  opening_balance?: string;

  /** For a credit card: what is owed today (entered as a positive amount). */
  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  owed?: string;
}

export class UpdateAccountDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @IsIn(ACCOUNT_TYPES)
  type?: AccountTypeValue;

  @IsOptional()
  @IsString()
  @Matches(CURRENCY)
  currency?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  opening_balance?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  owed?: string;
}

export class CreateCategoryDto {
  @IsIn(['expense', 'income'])
  kind!: 'expense' | 'income';

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @NoControlCharacters()
  name!: string;

  @IsOptional()
  @IsUUID()
  parent_id?: string;
}

export class UpdateCategoryDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  position?: number;
}

export class CreateTransactionDto {
  @IsIn(TRANSACTION_TYPES)
  type!: TransactionTypeValue;

  @DecimalString()
  @IsAmount('positive')
  amount!: string;

  @IsUUID()
  account_id!: string;

  /** Transfers only. */
  @IsOptional()
  @IsUUID()
  to_account_id?: string;

  /** Expenses and income. */
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsDateString({ strict: true })
  occurred_at!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(160)
  @NoControlCharacters()
  merchant?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateTransactionDto {
  @IsOptional()
  @DecimalString()
  @IsAmount('positive')
  amount?: string;

  @IsOptional()
  @IsUUID()
  account_id?: string;

  @IsOptional()
  @IsUUID()
  to_account_id?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  occurred_at?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(160)
  @NoControlCharacters()
  merchant?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ListTransactionsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(TRANSACTION_TYPES)
  type?: TransactionTypeValue;

  @IsOptional()
  @IsUUID()
  account_id?: string;

  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class SummaryQueryDto {
  @IsOptional()
  @IsIn(PERIODS)
  period?: PeriodValue;

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;
}

export class FinanceSettingsDto {
  @IsString()
  @Matches(CURRENCY)
  currency!: string;
}
