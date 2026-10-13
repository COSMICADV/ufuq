/**
 * Inventory on the client — DOCUMENT 17, DOCUMENT 04 B22–B24, DOCUMENT 05
 * FLOWs 17–18, DOCUMENT 08 §4.11.
 *
 * Pure, so every rule here is unit-tested without a DOM:
 *
 *   - **No quantity is ever edited.** The product form has no quantity field
 *     (DOCUMENT 04 B23: "there is no editable quantity field"). Stock changes
 *     only through the movement form, which posts a movement; a new product's
 *     optional initial stock becomes a `manual_addition` on the server.
 *   - **No stock arithmetic in the browser.** Quantities, costs and values are
 *     the server's decimal strings. A typed value is checked for shape only,
 *     to say early what the server will say; the server parses it exactly and
 *     decides the sign, the cost and the balance.
 *   - **Movement semantics mirror the server's**: a positive quantity whose
 *     sign the type decides (an adjustment is signed), a reason on adjustment
 *     and damage, a unit cost required on a purchase and refused on anything
 *     outbound. Transfers are not offered here — they are the warehouse
 *     screen's, which writes both legs together.
 *   - Forms keep what was typed when the server refuses it (DOCUMENT 11 §2).
 */

import { normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { ApiError } from './api-client';
import { normaliseQuantity } from './warehouse';
import type { Movement, ProductRef, WarehouseType } from './warehouse';

// -- Shapes -----------------------------------------------------------------------

export const PRODUCT_STATUSES = ['active', 'discontinued'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];
export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export interface Product {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly sku: string;
  readonly unit: string;
  readonly category: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
  } | null;
  readonly supplier: { readonly id: string; readonly name: string } | null;
  readonly min_stock: string;
  readonly cost_price: string;
  readonly selling_price: string;
  readonly image_attachment_id: string | null;
  readonly description: string | null;
  readonly status: ProductStatus;
  readonly total_quantity: string;
  readonly stock_value: string;
  readonly stock_status: StockStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProductStock {
  readonly warehouse: {
    readonly id: string;
    readonly name_ar: string;
    readonly name_en: string;
    readonly type: WarehouseType;
    readonly is_active: boolean;
  };
  readonly quantity: string;
  readonly average_cost: string;
  readonly stock_value: string;
}

export interface ProductDetail extends Product {
  readonly stock: readonly ProductStock[];
}

export interface Category {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly parent_id: string | null;
  readonly product_count: number;
}

export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly contact_person: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly status: SupplierStatus;
  readonly product_count: number;
}

export interface Alert {
  readonly product: Product;
  readonly alert: 'low_stock' | 'out_of_stock';
}

export interface CreatedMovement extends Movement {
  readonly negative_stock: boolean;
}

export interface ReconciliationMismatch {
  readonly product_id: string;
  readonly sku: string;
  readonly warehouse_id: string;
  readonly cached_quantity: string | null;
  readonly ledger_quantity: string;
  readonly cached_average_cost: string | null;
  readonly ledger_average_cost: string;
  readonly repaired: boolean;
}

export interface ReconciliationReport {
  readonly run_id: string;
  readonly mode: 'check' | 'rebuild';
  readonly products_checked: number;
  readonly balances_checked: number;
  readonly mismatches: readonly ReconciliationMismatch[];
  readonly repaired: number;
  readonly chain_breaks: readonly string[];
  readonly finished_at: string;
}

// -- Paths and display -------------------------------------------------------------

export function inventoryPath(locale: string, section?: 'new' | 'movements' | 'suppliers'): string {
  const base = `/${locale}/admin/inventory`;
  return section === undefined ? base : `${base}/${section}`;
}

export function productPath(locale: string, id: string, movements = false): string {
  return `/${locale}/admin/inventory/${id}${movements ? '/movements' : ''}`;
}

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'cancelled';

export function stockTone(status: StockStatus): Tone {
  if (status === 'out_of_stock') return 'danger';
  if (status === 'low_stock') return 'warning';
  return 'success';
}

/** The full name of a product in the reader's language. */
export function productName(product: ProductRef | Product, locale: Locale): string {
  const primary = locale === 'ar' ? product.name_ar : product.name_en;
  return primary.trim() === '' ? (locale === 'ar' ? product.name_en : product.name_ar) : primary;
}

/** Whether a decimal string is below zero (a negative balance under the company setting). */
export function isNegative(value: string): boolean {
  return value.startsWith('-') && /[1-9]/.test(value);
}

// -- Decimal shapes ------------------------------------------------------------------

const AMOUNT_SHAPE = /^\d{1,13}(\.\d{1,2})?$/;
const NON_NEGATIVE_QUANTITY = /^\d{1,12}(\.\d{1,3})?$/;

/** A non-negative money amount (price, cost), digits normalised; null when it is not one. */
export function normaliseAmount(raw: string): string | null {
  const value = normaliseDigits(raw.trim());
  return AMOUNT_SHAPE.test(value) ? value : null;
}

/** A non-negative DECIMAL(15,3) (a minimum stock level); null when it is not one. */
export function normaliseMinStock(raw: string): string | null {
  const value = normaliseDigits(raw.trim());
  return NON_NEGATIVE_QUANTITY.test(value) ? value : null;
}

// -- Product form ----------------------------------------------------------------------

export type Issues = Readonly<Record<string, string>>;

export interface ProductForm {
  readonly name_ar: string;
  readonly name_en: string;
  readonly sku: string;
  readonly unit: string;
  readonly category_id: string;
  readonly supplier_id: string;
  readonly min_stock: string;
  readonly cost_price: string;
  readonly selling_price: string;
  readonly description: string;
  /** FLOW 17's optional initial stock — create only. */
  readonly initial_warehouse_id: string;
  readonly initial_quantity: string;
  readonly initial_unit_cost: string;
}

export const EMPTY_PRODUCT_FORM: ProductForm = {
  name_ar: '',
  name_en: '',
  sku: '',
  unit: '',
  category_id: '',
  supplier_id: '',
  min_stock: '0',
  cost_price: '0.00',
  selling_price: '0.00',
  description: '',
  initial_warehouse_id: '',
  initial_quantity: '',
  initial_unit_cost: '',
};

export function formFromProduct(product: Product): ProductForm {
  return {
    ...EMPTY_PRODUCT_FORM,
    name_ar: product.name_ar,
    name_en: product.name_en,
    sku: product.sku,
    unit: product.unit,
    category_id: product.category?.id ?? '',
    supplier_id: product.supplier?.id ?? '',
    min_stock: product.min_stock,
    cost_price: product.cost_price,
    selling_price: product.selling_price,
    description: product.description ?? '',
  };
}

const NAME_MAX = 200;
const SKU_MAX = 50;
const UNIT_MAX = 20;

/** DOCUMENT 17 "Validation": name and SKU (1–50) required, prices and min stock ≥ 0. */
export function validateProductForm(form: ProductForm, creating: boolean): Issues {
  const issues: Record<string, string> = {};
  for (const field of ['name_ar', 'name_en'] as const) {
    const value = form[field].trim();
    if (value === '') issues[field] = 'validation.required';
    else if (value.length > NAME_MAX) issues[field] = 'validation.too_long';
  }
  const sku = form.sku.trim();
  if (sku === '') issues.sku = 'validation.required';
  else if (sku.length > SKU_MAX) issues.sku = 'validation.too_long';
  const unit = form.unit.trim();
  if (unit === '') issues.unit = 'validation.required';
  else if (unit.length > UNIT_MAX) issues.unit = 'validation.too_long';
  if (normaliseMinStock(form.min_stock) === null)
    issues.min_stock = 'validation.non_negative_quantity';
  for (const field of ['cost_price', 'selling_price'] as const) {
    if (normaliseAmount(form[field]) === null) issues[field] = 'validation.amount';
  }
  if (creating) {
    const any = form.initial_warehouse_id !== '' || form.initial_quantity.trim() !== '';
    if (any) {
      if (form.initial_warehouse_id === '') issues.initial_warehouse_id = 'validation.required';
      if (normaliseQuantity(form.initial_quantity) === null)
        issues.initial_quantity = 'validation.quantity';
      if (
        form.initial_unit_cost.trim() !== '' &&
        normaliseAmount(form.initial_unit_cost) === null
      ) {
        issues.initial_unit_cost = 'validation.amount';
      }
    }
  }
  return issues;
}

/** The create body, or — given the original — only the fields that changed. Never a quantity. */
export function productBody(form: ProductForm, original?: Product): Record<string, unknown> {
  const next: Record<string, unknown> = {
    name_ar: form.name_ar.trim(),
    name_en: form.name_en.trim(),
    sku: form.sku.trim(),
    unit: form.unit.trim(),
    category_id: form.category_id === '' ? null : form.category_id,
    supplier_id: form.supplier_id === '' ? null : form.supplier_id,
    min_stock: normaliseMinStock(form.min_stock) ?? form.min_stock.trim(),
    cost_price: normaliseAmount(form.cost_price) ?? form.cost_price.trim(),
    selling_price: normaliseAmount(form.selling_price) ?? form.selling_price.trim(),
    description: form.description.trim() === '' ? null : form.description.trim(),
  };
  if (original === undefined) {
    const body = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
    if (form.initial_warehouse_id !== '' && form.initial_quantity.trim() !== '') {
      body.initial_stock = {
        warehouse_id: form.initial_warehouse_id,
        quantity: normaliseQuantity(form.initial_quantity) ?? form.initial_quantity.trim(),
        ...(form.initial_unit_cost.trim() === ''
          ? {}
          : {
              unit_cost: normaliseAmount(form.initial_unit_cost) ?? form.initial_unit_cost.trim(),
            }),
      };
    }
    return body;
  }
  const before = formFromProduct(original);
  const previous = productBody(before);
  return Object.fromEntries(
    Object.entries(next).filter(([key, value]) => {
      if (key === 'category_id') return value !== (original.category?.id ?? null);
      if (key === 'supplier_id') return value !== (original.supplier?.id ?? null);
      if (key === 'description') return value !== original.description;
      return value !== previous[key];
    }),
  );
}

/** Rule 10: the duplicate-SKU field error names the product that has it. */
export function duplicateSku(
  error: ApiError,
): { readonly id: string; readonly name_ar: string; readonly name_en: string } | null {
  const id = error.fields.existing_product_id?.[0];
  if (id === undefined) return null;
  return {
    id,
    name_ar: error.fields.existing_product_name_ar?.[0] ?? '',
    name_en: error.fields.existing_product_name_en?.[0] ?? '',
  };
}

// -- Movement form (FLOW 18) --------------------------------------------------------------

export const MOVEMENT_FORM_TYPES = [
  'purchase',
  'sale',
  'return',
  'damage',
  'adjustment',
  'manual_addition',
  'manual_removal',
] as const;
export type MovementFormType = (typeof MOVEMENT_FORM_TYPES)[number];

const INBOUND: readonly MovementFormType[] = ['purchase', 'return', 'manual_addition'];
const OUTBOUND: readonly MovementFormType[] = ['sale', 'damage', 'manual_removal'];

export function isOutboundType(type: MovementFormType): boolean {
  return OUTBOUND.includes(type);
}
export function isInboundType(type: MovementFormType): boolean {
  return INBOUND.includes(type);
}
export function reasonRequired(type: MovementFormType | ''): boolean {
  return type === 'adjustment' || type === 'damage';
}

export type AdjustmentDirection = 'increase' | 'decrease';

export interface MovementForm {
  readonly warehouse_id: string;
  readonly type: MovementFormType | '';
  /** Always a positive magnitude; an adjustment's sign comes from `direction`. */
  readonly quantity: string;
  readonly direction: AdjustmentDirection;
  readonly unit_cost: string;
  readonly reason: string;
}

export const EMPTY_MOVEMENT_FORM: MovementForm = {
  warehouse_id: '',
  type: '',
  quantity: '',
  direction: 'decrease',
  unit_cost: '',
  reason: '',
};

/** Whether the form describes stock leaving the location. */
export function movementIsOutbound(form: MovementForm): boolean {
  if (form.type === '') return false;
  if (form.type === 'adjustment') return form.direction === 'decrease';
  return isOutboundType(form.type);
}

/** Whether a unit cost may be entered at all (inbound only). */
export function costAllowed(form: MovementForm): boolean {
  return form.type !== '' && !movementIsOutbound(form);
}

export function validateMovementForm(form: MovementForm): Issues {
  const issues: Record<string, string> = {};
  if (form.warehouse_id === '') issues.warehouse_id = 'validation.required';
  if (form.type === '') issues.type = 'validation.required';
  if (form.quantity.trim() === '') issues.quantity = 'validation.required';
  else if (normaliseQuantity(form.quantity) === null) issues.quantity = 'validation.quantity';
  if (form.type === 'purchase' && form.unit_cost.trim() === '')
    issues.unit_cost = 'validation.required';
  else if (form.unit_cost.trim() !== '' && normaliseAmount(form.unit_cost) === null) {
    issues.unit_cost = 'validation.amount';
  }
  if (reasonRequired(form.type) && form.reason.trim() === '') issues.reason = 'validation.required';
  if (form.reason.trim().length > 1000) issues.reason = 'validation.too_long';
  return issues;
}

export function movementBody(
  form: MovementForm,
  productId: string,
  acknowledgeNegative = false,
): Record<string, unknown> {
  const magnitude = normaliseQuantity(form.quantity) ?? form.quantity.trim();
  const quantity =
    form.type === 'adjustment' && form.direction === 'decrease' ? `-${magnitude}` : magnitude;
  return {
    product_id: productId,
    warehouse_id: form.warehouse_id,
    type: form.type,
    quantity,
    ...(costAllowed(form) && form.unit_cost.trim() !== ''
      ? { unit_cost: normaliseAmount(form.unit_cost) ?? form.unit_cost.trim() }
      : {}),
    ...(form.reason.trim() === '' ? {} : { reason: form.reason.trim() }),
    ...(acknowledgeNegative ? { acknowledge_negative_stock: true } : {}),
  };
}

/** STOCK_NEGATIVE_WARNING / STOCK_INSUFFICIENT: the figures the server named. */
export function stockFigures(error: ApiError): {
  readonly available: string;
  readonly requested: string;
  readonly resulting: string | null;
} | null {
  const available = error.fields.available?.[0];
  const requested = error.fields.requested?.[0];
  if (available === undefined || requested === undefined) return null;
  return { available, requested, resulting: error.fields.resulting_balance?.[0] ?? null };
}

// -- Supplier form ---------------------------------------------------------------------

export interface SupplierForm {
  readonly name: string;
  readonly contact_person: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
}

export const EMPTY_SUPPLIER_FORM: SupplierForm = {
  name: '',
  contact_person: '',
  phone: '',
  email: '',
  address: '',
};

export function formFromSupplier(supplier: Supplier): SupplierForm {
  return {
    name: supplier.name,
    contact_person: supplier.contact_person ?? '',
    phone: supplier.phone ?? '',
    email: supplier.email ?? '',
    address: supplier.address ?? '',
  };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_SHAPE = /^\+?[0-9][0-9 -]{2,28}$/;

export function validateSupplierForm(form: SupplierForm): Issues {
  const issues: Record<string, string> = {};
  if (form.name.trim() === '') issues.name = 'validation.required';
  else if (form.name.trim().length > NAME_MAX) issues.name = 'validation.too_long';
  if (form.email.trim() !== '' && !EMAIL_SHAPE.test(form.email.trim()))
    issues.email = 'validation.invalid';
  if (form.phone.trim() !== '' && !PHONE_SHAPE.test(normaliseDigits(form.phone.trim()))) {
    issues.phone = 'validation.invalid';
  }
  return issues;
}

export function supplierBody(form: SupplierForm, original?: Supplier): Record<string, unknown> {
  const next: Record<string, string | null> = {
    name: form.name.trim(),
    contact_person: form.contact_person.trim() === '' ? null : form.contact_person.trim(),
    phone: form.phone.trim() === '' ? null : normaliseDigits(form.phone.trim()),
    email: form.email.trim() === '' ? null : form.email.trim(),
    address: form.address.trim() === '' ? null : form.address.trim(),
  };
  if (original === undefined) {
    return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== null));
  }
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => value !== (original[key as keyof Supplier] ?? null),
    ),
  );
}
