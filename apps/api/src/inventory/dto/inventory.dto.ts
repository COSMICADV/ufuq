/**
 * Inventory request shapes — DOCUMENT 08 §4.11, DOCUMENT 17 "Validation",
 * DOCUMENT 06 §3.29, §3.30, §3.33.
 *
 * Decimals (quantities, prices, costs) travel as strings and are parsed
 * exactly by the services, which name the failing field. **No product shape
 * has a quantity field**: stock changes only through a movement (DOCUMENT 17
 * rule 1). The only quantity a product request carries is the optional
 * initial stock of FLOW 17, which becomes a `manual_addition` movement in the
 * same transaction. The global validation pipe rejects unknown fields.
 */

import { normaliseDigits } from '@ufuq/i18n';
import { Transform, Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../company-structure/dto/pagination.dto.js';
import {
  NAME_MAX_LENGTH,
  NoControlCharacters,
  TrimmedText,
} from '../../company-structure/validation.js';
import { SORT_ORDERS } from '../../employees/dto/employee.dto.js';
import type { SortOrder } from '../../employees/dto/employee.dto.js';
import { ALL_MOVEMENT_TYPES, REASON_MAX } from '../inventory-rules.js';

export const SKU_MAX = 50;
export const UNIT_MAX = 20;
export const DESCRIPTION_MAX = 5000;
export const SEARCH_MAX = 100;
const DECIMAL_TEXT_MAX = 20;
const PHONE_PATTERN = /^\+?[0-9][0-9 -]{2,28}$/;

export const PRODUCT_STATUSES = ['active', 'discontinued'] as const;
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'] as const;
export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
/** DOCUMENT 08 §1 sort whitelist for `GET /products`. */
export const PRODUCT_SORTS = ['name', 'sku', 'created_at', 'total_quantity'] as const;

function DecimalText(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'string' ? normaliseDigits(value.trim()) : value,
  );
}

function Lowercase(): PropertyDecorator {
  return Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));
}

/** FLOW 17: "initial stock: location + quantity (optional)". */
export class InitialStockDto {
  @IsUUID()
  warehouse_id!: string;

  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  quantity!: string;

  /** Optional: absent, the product's cost price is used. */
  @IsOptional()
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  unit_cost?: string;
}

class ProductFields {
  @IsOptional()
  @IsUUID()
  category_id?: string | null;

  @IsOptional()
  @IsUUID()
  supplier_id?: string | null;

  @IsOptional()
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  min_stock?: string;

  @IsOptional()
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  cost_price?: string;

  @IsOptional()
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  selling_price?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(DESCRIPTION_MAX)
  description?: string | null;
}

export class CreateProductDto extends ProductFields {
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

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(SKU_MAX)
  @NoControlCharacters()
  sku!: string;

  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(UNIT_MAX)
  @NoControlCharacters()
  unit!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InitialStockDto)
  initial_stock?: InitialStockDto;
}

/** PATCH /products/{id}. Deactivation is `status: "discontinued"`. No quantity — ever. */
export class UpdateProductDto extends ProductFields {
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
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(SKU_MAX)
  @NoControlCharacters()
  sku?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(UNIT_MAX)
  @NoControlCharacters()
  unit?: string;

  @IsOptional()
  @IsIn(PRODUCT_STATUSES)
  status?: (typeof PRODUCT_STATUSES)[number];

  /** The image: an attachment already uploaded to this product (related_type `product`), or null to clear it. */
  @IsOptional()
  @IsUUID()
  image_attachment_id?: string | null;
}

/** GET /products — DOCUMENT 04 B22: filters category, location, status, supplier; search name, SKU. */
export class ListProductsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  category_id?: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  supplier_id?: string;

  /** Products holding stock at this location. */
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  warehouse_id?: string;

  @IsOptional()
  @IsIn(PRODUCT_STATUSES, { message: 'invalid' })
  status?: (typeof PRODUCT_STATUSES)[number];

  @IsOptional()
  @IsIn(STOCK_STATUSES, { message: 'invalid' })
  stock_status?: (typeof STOCK_STATUSES)[number];

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(SEARCH_MAX)
  @NoControlCharacters()
  search?: string;

  @IsOptional()
  @IsIn(PRODUCT_SORTS, { message: 'invalid' })
  sort?: (typeof PRODUCT_SORTS)[number];

  @IsOptional()
  @IsIn(SORT_ORDERS, { message: 'invalid' })
  order?: SortOrder;
}

export class CreateCategoryDto {
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

  /** DOCUMENT 06 §3.30 `parent_id`. */
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;
}

class SupplierFields {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  contact_person?: string | null;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? normaliseDigits(value.trim()) : value))
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'invalid' })
  @MaxLength(30)
  phone?: string | null;

  @IsOptional()
  @Lowercase()
  @IsEmail({}, { message: 'invalid' })
  @MaxLength(254)
  email?: string | null;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(1000)
  address?: string | null;
}

export class CreateSupplierDto extends SupplierFields {
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name!: string;
}

export class UpdateSupplierDto extends SupplierFields {
  @IsOptional()
  @TrimmedText()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  @NoControlCharacters()
  name?: string;

  @IsOptional()
  @IsIn(SUPPLIER_STATUSES)
  status?: (typeof SUPPLIER_STATUSES)[number];
}

export class ListSuppliersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(SUPPLIER_STATUSES, { message: 'invalid' })
  status?: (typeof SUPPLIER_STATUSES)[number];

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(SEARCH_MAX)
  @NoControlCharacters()
  search?: string;
}

/** POST /stock-movements — DOCUMENT 05 FLOW 18. `transfer_*` are refused: use the transfer endpoint. */
export class CreateMovementDto {
  @IsUUID()
  product_id!: string;

  @IsUUID()
  warehouse_id!: string;

  @IsIn(ALL_MOVEMENT_TYPES)
  type!: (typeof ALL_MOVEMENT_TYPES)[number];

  /** Positive; signed only for `adjustment`. */
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  quantity!: string;

  @IsOptional()
  @DecimalText()
  @IsString()
  @MaxLength(DECIMAL_TEXT_MAX)
  unit_cost?: string;

  @IsOptional()
  @TrimmedText()
  @IsString()
  @MaxLength(REASON_MAX)
  @NoControlCharacters()
  reason?: string;

  /** FLOW 18 "negative allowed by policy → warn and continue": the Admin's confirmation. */
  @IsOptional()
  @IsBoolean()
  acknowledge_negative_stock?: boolean;
}

/** POST /inventory/reconciliation. */
export class RunReconciliationDto {
  /** false (default): check and report only. true: rebuild every mismatched balance from the ledger. */
  @IsOptional()
  @IsBoolean()
  rebuild?: boolean;
}
