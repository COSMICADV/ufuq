/** `/personal/car` request shapes. Kilometres are whole numbers. */

import { IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { NoControlCharacters, NumericInput, TrimmedText } from '../company-structure/validation.js';

export class CreateVehicleDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @NoControlCharacters()
  name!: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(60)
  @NoControlCharacters()
  make?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(60)
  @NoControlCharacters()
  model?: string;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1950)
  @Max(2100)
  year?: number;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(20)
  @NoControlCharacters()
  plate?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(20)
  @NoControlCharacters()
  fuel_type?: string;

  /** The odometer today, if known: saved as the first reading. */
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(9_999_999)
  current_km?: number;
}

export class UpdateVehicleDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(60)
  @NoControlCharacters()
  make?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(60)
  @NoControlCharacters()
  model?: string;

  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(1950)
  @Max(2100)
  year?: number;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(20)
  @NoControlCharacters()
  plate?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(20)
  @NoControlCharacters()
  fuel_type?: string;
}

export class CreateReadingDto {
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(9_999_999)
  reading_km!: number;

  @IsDateString({ strict: true })
  read_at!: string;

  @IsOptional()
  @IsIn(['normal', 'reset', 'replacement'])
  kind?: 'normal' | 'reset' | 'replacement';

  @IsOptional()
  @IsIn(['photo', 'manual'])
  source?: 'photo' | 'manual';

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** The person has seen the "unusual jump" warning and confirms the reading. */
  @IsOptional()
  @IsBoolean()
  confirm_unusual?: boolean;
}

export class UpdateReadingDto {
  @IsOptional()
  @NumericInput()
  @IsInt()
  @Min(0)
  @Max(9_999_999)
  reading_km?: number;

  @IsOptional()
  @IsDateString({ strict: true })
  read_at?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsOptional()
  @IsBoolean()
  confirm_unusual?: boolean;
}
