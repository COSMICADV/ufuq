/**
 * Request bodies and queries for /restaurant. Amounts are decimal strings,
 * parsed by @ufuq/money and never by Number; text is trimmed and refuses
 * control characters; ids are UUIDs.
 */

import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { NoControlCharacters, TrimmedText } from '../company-structure/validation.js';
import { DecimalString, IsAmount } from '../payroll/dto/payroll.dto.js';

import { ORDER_STATUSES, ORDER_TYPES, RESTAURANT_ROLES, TIME_PATTERN } from './restaurant-rules.js';
import type { OrderStatus, OrderType, RestaurantRoleKey } from './restaurant-rules.js';

const RATE_MAX = '100.00';

function Text(max: number): PropertyDecorator {
  return (target, key) => {
    TrimmedText()(target, key);
    IsString()(target, key);
    MaxLength(max)(target, key);
    NoControlCharacters()(target, key);
  };
}

/** Optional text where an explicit null clears it. */
function OptionalText(max: number): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    ValidateIf((_: unknown, v: unknown) => v !== null)(target, key);
    Text(max)(target, key);
  };
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export class CreateBranchDto {
  @Text(120)
  @MinLength(1)
  name!: string;

  @OptionalText(300)
  address?: string | null;

  @OptionalText(40)
  phone?: string | null;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative', RATE_MAX)
  tax_rate?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative', RATE_MAX)
  service_rate?: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @Text(120)
  @MinLength(1)
  name?: string;

  @OptionalText(300)
  address?: string | null;

  @OptionalText(40)
  phone?: string | null;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative', RATE_MAX)
  tax_rate?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative', RATE_MAX)
  service_rate?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export class UpdateStaffDto {
  @IsUUID()
  branch_id!: string;

  @IsIn(RESTAURANT_ROLES)
  role!: RestaurantRoleKey;

  @OptionalText(80)
  job_title?: string | null;

  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  working_days!: number[];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_PATTERN)
  shift_start?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(TIME_PATTERN)
  shift_end?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(480)
  break_minutes?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export class CreateTableDto {
  @IsUUID()
  branch_id!: string;

  @Text(30)
  @MinLength(1)
  label!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  seats?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  default_waiter_id?: string | null;
}

export class UpdateTableDto {
  @IsOptional()
  @Text(30)
  @MinLength(1)
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  seats?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  default_waiter_id?: string | null;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class BranchQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export class CategoryDto {
  @Text(80)
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sort_order?: number;
}

export class UpdateCategoryDto {
  @IsOptional()
  @Text(80)
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sort_order?: number;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class SizeDto {
  @Text(60)
  @MinLength(1)
  name!: string;

  @DecimalString()
  @IsAmount('non_negative')
  price!: string;
}

export class OptionDto {
  @IsIn(['extra', 'customization'])
  kind!: 'extra' | 'customization';

  @Text(80)
  @MinLength(1)
  name!: string;

  @DecimalString()
  @IsAmount('non_negative')
  price!: string;
}

class ItemFields {
  @OptionalText(600)
  description?: string | null;

  @OptionalText(1000)
  ingredients?: string | null;

  @OptionalText(4000)
  recipe?: string | null;

  @OptionalText(2000)
  prep_instructions?: string | null;

  @IsOptional()
  @IsBoolean()
  available?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sort_order?: number;

  /** Replaces every size when present. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SizeDto)
  sizes?: SizeDto[];

  /** Replaces every extra and customization when present. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => OptionDto)
  options?: OptionDto[];
}

export class CreateItemDto extends ItemFields {
  @IsUUID()
  category_id!: string;

  @Text(120)
  @MinLength(1)
  name!: string;

  @DecimalString()
  @IsAmount('non_negative')
  price!: string;
}

export class UpdateItemDto extends ItemFields {
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @IsOptional()
  @Text(120)
  @MinLength(1)
  name?: string;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  price?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class MenuQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  archived?: 'true' | 'false';
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export class OrderLineDto {
  @IsUUID()
  menu_item_id!: string;

  @IsOptional()
  @IsUUID()
  size_id?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @IsUUID(undefined, { each: true })
  option_ids?: string[];

  @IsInt()
  @Min(1)
  @Max(999)
  quantity!: number;

  @OptionalText(300)
  notes?: string | null;
}

export class CreateOrderDto {
  /** A fresh random key per tap of "Confirm" — a repeat returns the first order. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  client_key!: string;

  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsIn(ORDER_TYPES)
  type!: OrderType;

  @ValidateIf((dto: CreateOrderDto) => dto.type === 'dine_in')
  @IsUUID()
  table_id?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  waiter_id?: string | null;

  @ValidateIf(
    (dto: CreateOrderDto) =>
      dto.type === 'delivery' || (dto.customer_name !== undefined && dto.customer_name !== null),
  )
  @Text(120)
  @MinLength(1)
  customer_name?: string | null;

  @ValidateIf(
    (dto: CreateOrderDto) =>
      dto.type === 'delivery' || (dto.customer_phone !== undefined && dto.customer_phone !== null),
  )
  @Text(40)
  @Matches(/^[+0-9٠-٩۰-۹ ()-]{5,40}$/)
  customer_phone?: string | null;

  @ValidateIf((dto: CreateOrderDto) => dto.type === 'delivery')
  @Text(400)
  @MinLength(3)
  delivery_address?: string | null;

  @OptionalText(500)
  notes?: string | null;

  @IsOptional()
  @DecimalString()
  @IsAmount('non_negative')
  discount?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  items!: OrderLineDto[];
}

export const ORDER_VIEWS = ['active', 'kitchen', 'waiter', 'pickup', 'history'] as const;
export type OrderView = (typeof ORDER_VIEWS)[number];

export class OrdersQueryDto {
  @IsOptional()
  @IsUUID()
  branch_id?: string;

  @IsIn(ORDER_VIEWS)
  view!: OrderView;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class StatusDto {
  @IsIn(ORDER_STATUSES.filter((s) => s !== 'cancelled'))
  status!: Exclude<OrderStatus, 'cancelled'>;
}

export class CancelDto {
  @Text(300)
  @MinLength(2)
  reason!: string;
}

export class WaiterDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  waiter_id!: string | null;
}

export class ImageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(12)
  v?: string;
}
