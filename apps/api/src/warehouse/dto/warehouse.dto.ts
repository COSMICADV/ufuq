/**
 * Warehouse request shapes — DOCUMENT 08 §4.11, DOCUMENT 17 "Validation".
 *
 * Quantities travel as strings, never JSON numbers (DOCUMENT 08 §1). Nothing
 * here sets a quantity: there is no field that writes stock, only the
 * transfer's lines, which become movements (DOCUMENT 17 rule 1). The global
 * validation pipe rejects unknown fields, nested ones included.
 */

import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { normaliseDigits } from '@ufuq/i18n';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  IsCalendarDate,
  NAME_MAX_LENGTH,
  NoControlCharacters,
  TrimmedText,
} from '../../company-structure/validation.js';
import { TRANSFER_LINES_MAX, WAREHOUSE_TYPES } from '../warehouse-rules.js';
import type { WarehouseTypeValue } from '../warehouse-rules.js';

const ADDRESS_MAX = 1000;
const NOTE_MAX = 1000;
const BOOLEAN_STRINGS = ['true', 'false'] as const;
const MOVEMENT_TYPES = [
  'purchase',
  'sale',
  'transfer_in',
  'transfer_out',
  'adjustment',
  'return',
  'damage',
  'manual_addition',
  'manual_removal',
] as const;

export class CreateWarehouseDto {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters({ message: 'name_ar must not contain control characters' })
  name_ar!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters({ message: 'name_en must not contain control characters' })
  name_en!: string;

  @IsIn(WAREHOUSE_TYPES)
  type!: WarehouseTypeValue;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(ADDRESS_MAX)
  @NoControlCharacters({ message: 'address must not contain control characters' })
  address?: string | null;
}

/** PATCH /warehouses/{id}. Deactivation is `is_active: false` — refused while stock remains. */
export class UpdateWarehouseDto {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters({ message: 'name_ar must not contain control characters' })
  name_ar?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters({ message: 'name_en must not contain control characters' })
  name_en?: string;

  @IsOptional()
  @IsIn(WAREHOUSE_TYPES)
  type?: WarehouseTypeValue;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(ADDRESS_MAX)
  @NoControlCharacters({ message: 'address must not contain control characters' })
  address?: string | null;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}

export class ListWarehousesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(WAREHOUSE_TYPES)
  type?: WarehouseTypeValue;

  @IsOptional()
  @IsIn(BOOLEAN_STRINGS)
  is_active?: (typeof BOOLEAN_STRINGS)[number];
}

/** GET /stock-movements — DOCUMENT 08 §4.11 filters: product, warehouse, type, date range, user. */
export class ListMovementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsUUID()
  warehouse_id?: string;

  @IsOptional()
  @IsIn(MOVEMENT_TYPES)
  type?: (typeof MOVEMENT_TYPES)[number];

  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @IsOptional()
  @IsCalendarDate()
  to?: string;

  @IsOptional()
  @IsUUID()
  created_by?: string;
}

export class TransferLineDto {
  @IsUUID()
  product_id!: string;

  /** DECIMAL(15,3) as a string; parsed exactly by the service. */
  @Transform(({ value }) => (typeof value === 'string' ? normaliseDigits(value.trim()) : value))
  @IsString()
  @MaxLength(20)
  quantity!: string;
}

/** POST /warehouses/transfers — DOCUMENT 04 B21: source, destination, products with quantities, note. */
export class CreateTransferDto {
  @IsUUID()
  source_warehouse_id!: string;

  @IsUUID()
  destination_warehouse_id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TRANSFER_LINES_MAX)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  lines!: TransferLineDto[];

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(NOTE_MAX)
  @NoControlCharacters({ message: 'note must not contain control characters' })
  note?: string;
}
