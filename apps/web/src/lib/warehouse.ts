/**
 * Warehouse on the client — DOCUMENT 17, DOCUMENT 04 B19–B21, DOCUMENT 08
 * §4.11.
 *
 * Pure, so every rule here is unit-tested without a DOM:
 *
 *   - **No quantity is ever edited.** There is no form, field or request here
 *     that sets a stock quantity (DOCUMENT 17 rule 1). Stock is read from the
 *     ledger; the only write is a transfer, which the server turns into
 *     paired movements.
 *   - **No stock arithmetic in the browser.** Quantities and values are the
 *     server's decimal strings. A typed quantity is checked for shape (up to
 *     three decimals) and compared against what the source holds — exactly,
 *     as scaled integers, never as floating point — only to say early what
 *     the server will say. The server checks again under its row lock.
 *   - Forms keep what was typed when the server refuses it (DOCUMENT 11 §2).
 */

import { formatMoney, normaliseDigits } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { ApiError } from './api-client';

// -- Shapes -----------------------------------------------------------------------

/** DOCUMENT 17 "Data": an online channel is a location type, not a second stock model. */
export const WAREHOUSE_TYPES = ['main', 'branch', 'store', 'production', 'online'] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

export interface Warehouse {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly type: WarehouseType;
  readonly address: string | null;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly product_count: number;
  readonly total_quantity: string;
  readonly stock_value: string;
}

export interface ProductRef {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly sku: string;
  readonly unit: string;
}

export interface WarehouseRef {
  readonly id: string;
  readonly name_ar: string;
  readonly name_en: string;
  readonly type: WarehouseType;
}

export interface StockRow {
  readonly product: ProductRef;
  readonly quantity: string;
  readonly average_cost: string;
  readonly stock_value: string;
}

export const MOVEMENT_TYPES = [
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
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface Movement {
  readonly id: string;
  readonly product: ProductRef;
  readonly warehouse: WarehouseRef;
  readonly type: MovementType;
  readonly quantity: string;
  readonly unit_cost: string | null;
  readonly balance_after: string;
  readonly transfer_group_id: string | null;
  readonly reason: string | null;
  readonly created_by: { readonly id: string; readonly email: string } | null;
  readonly created_at: string;
}

export interface TransferLine {
  readonly product: ProductRef;
  readonly quantity: string;
  readonly unit_cost: string;
  readonly out_movement_id: string;
  readonly in_movement_id: string;
  readonly source_balance_after: string;
  readonly destination_balance_after: string;
}

export interface Transfer {
  readonly transfer_group_id: string;
  readonly source: WarehouseRef;
  readonly destination: WarehouseRef;
  readonly lines: readonly TransferLine[];
  readonly note: string | null;
  readonly value: string;
  readonly created_by: { readonly id: string; readonly email: string } | null;
  readonly created_at: string;
}

export interface WarehouseDashboard {
  readonly kpis: {
    readonly locations_total: number;
    readonly locations_active: number;
    readonly products_in_stock: number;
    readonly total_stock_units: string;
    readonly total_inventory_value: string;
  };
  readonly by_location: readonly Warehouse[];
  readonly recent_movements: readonly Movement[];
  readonly activity_trend: readonly { readonly date: string; readonly movements: number }[];
  /** What waits for Phase 14's product catalogue (minimum stock, catalogue count). */
  readonly deferred: readonly string[];
}

// -- Paths and display -------------------------------------------------------------

export type WarehouseSection = 'locations' | 'transfers';

export function warehousePath(locale: string, section?: WarehouseSection, id?: string): string {
  const base = `/${locale}/admin/warehouse`;
  if (section === undefined) return base;
  return id === undefined ? `${base}/${section}` : `${base}/${section}/${id}`;
}

/** The name in the reader's language, the other one as a fallback. */
export function localName(
  entity: { readonly name_ar: string; readonly name_en: string },
  locale: Locale,
): string {
  const primary = locale === 'ar' ? entity.name_ar : entity.name_en;
  return primary.trim() === '' ? (locale === 'ar' ? entity.name_en : entity.name_ar) : primary;
}

/** "120.500" → "120.5", "10.000" → "10": trailing zeros only; never rounded. */
export function quantityLabel(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' ? '0' : trimmed;
}

/** Money with its piastres — stock value and average cost are DECIMAL(15,2). */
export function money(amount: string, currency: string, locale: Locale): string {
  return formatMoney(amount, currency, { locale, showDecimals: true });
}

export function isInbound(type: MovementType): boolean {
  return (
    type === 'purchase' || type === 'transfer_in' || type === 'return' || type === 'manual_addition'
  );
}

export type Tone = 'info' | 'warning' | 'success' | 'danger' | 'cancelled';

export function movementTone(type: MovementType): Tone {
  if (type === 'transfer_in' || type === 'transfer_out') return 'info';
  if (type === 'damage') return 'danger';
  if (type === 'adjustment') return 'warning';
  return isInbound(type) ? 'success' : 'cancelled';
}

// -- Exact quantity comparison ---------------------------------------------------------

const QUANTITY_SHAPE = /^\d{1,12}(\.\d{1,3})?$/;

/** A typed quantity, digits normalised; null when it is not a positive DECIMAL(15,3). */
export function normaliseQuantity(raw: string): string | null {
  const value = normaliseDigits(raw.trim());
  if (!QUANTITY_SHAPE.test(value)) return null;
  return thousandths(value) > 0n ? value : null;
}

/** "12.5" → 12500n. Integer thousandths, so comparison is exact. */
function thousandths(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const scaled = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0').slice(0, 3));
  return negative ? -scaled : scaled;
}

/** Whether `requested` fits within `available` (both decimal strings). */
export function withinAvailable(requested: string, available: string): boolean {
  return thousandths(requested) <= thousandths(available);
}

// -- Location form -----------------------------------------------------------------

export type Issues = Readonly<Record<string, string>>;

export interface WarehouseForm {
  readonly name_ar: string;
  readonly name_en: string;
  readonly type: WarehouseType | '';
  readonly address: string;
}

export const EMPTY_WAREHOUSE_FORM: WarehouseForm = {
  name_ar: '',
  name_en: '',
  type: '',
  address: '',
};

const NAME_MAX = 200;
const ADDRESS_MAX = 1000;
const NOTE_MAX = 1000;

export function formFromWarehouse(warehouse: Warehouse): WarehouseForm {
  return {
    name_ar: warehouse.name_ar,
    name_en: warehouse.name_en,
    type: warehouse.type,
    address: warehouse.address ?? '',
  };
}

export function validateWarehouseForm(form: WarehouseForm): Issues {
  const issues: Record<string, string> = {};
  for (const field of ['name_ar', 'name_en'] as const) {
    const value = form[field].trim();
    if (value === '') issues[field] = 'validation.required';
    else if (value.length > NAME_MAX) issues[field] = 'validation.too_long';
  }
  if (form.type === '') issues.type = 'validation.required';
  if (form.address.trim().length > ADDRESS_MAX) issues.address = 'validation.too_long';
  return issues;
}

/** The create body; on edit, only what changed is sent. */
export function warehouseBody(form: WarehouseForm, original?: Warehouse): Record<string, unknown> {
  const next = {
    name_ar: form.name_ar.trim(),
    name_en: form.name_en.trim(),
    type: form.type,
    address: form.address.trim() === '' ? null : form.address.trim(),
  };
  if (original === undefined) {
    return next.address === null
      ? { name_ar: next.name_ar, name_en: next.name_en, type: next.type }
      : next;
  }
  const changed: Record<string, unknown> = {};
  if (next.name_ar !== original.name_ar) changed.name_ar = next.name_ar;
  if (next.name_en !== original.name_en) changed.name_en = next.name_en;
  if (next.type !== original.type) changed.type = next.type;
  if (next.address !== original.address) changed.address = next.address;
  return changed;
}

// -- Transfer form ------------------------------------------------------------------

export interface TransferLineForm {
  readonly product_id: string;
  readonly quantity: string;
}

export interface TransferForm {
  readonly source_warehouse_id: string;
  readonly destination_warehouse_id: string;
  readonly lines: readonly TransferLineForm[];
  readonly note: string;
}

export const EMPTY_LINE: TransferLineForm = { product_id: '', quantity: '' };

export function emptyTransferForm(sourceId = ''): TransferForm {
  return {
    source_warehouse_id: sourceId,
    destination_warehouse_id: '',
    lines: [EMPTY_LINE],
    note: '',
  };
}

/**
 * DOCUMENT 17 "Validation", checked before sending: both locations chosen and
 * different, at least one line, each product once, a positive quantity of at
 * most three decimals that the source holds. Keys match the server's fields.
 */
export function validateTransferForm(
  form: TransferForm,
  available: ReadonlyMap<string, string>,
): Issues {
  const issues: Record<string, string> = {};
  if (form.source_warehouse_id === '') issues.source_warehouse_id = 'validation.required';
  if (form.destination_warehouse_id === '') issues.destination_warehouse_id = 'validation.required';
  else if (form.destination_warehouse_id === form.source_warehouse_id) {
    issues.destination_warehouse_id = 'validation.same_location';
  }
  if (form.lines.length === 0) issues.lines = 'validation.required';
  const seen = new Set<string>();
  form.lines.forEach((line, index) => {
    if (line.product_id === '') {
      issues[`lines.${String(index)}.product_id`] = 'validation.required';
    } else if (seen.has(line.product_id)) {
      issues[`lines.${String(index)}.product_id`] = 'validation.duplicate_product';
    }
    seen.add(line.product_id);
    const quantity = line.quantity.trim() === '' ? null : normaliseQuantity(line.quantity);
    if (line.quantity.trim() === '') {
      issues[`lines.${String(index)}.quantity`] = 'validation.required';
    } else if (quantity === null) {
      issues[`lines.${String(index)}.quantity`] = 'validation.quantity';
    } else {
      const held = available.get(line.product_id);
      if (held !== undefined && !withinAvailable(quantity, held)) {
        issues[`lines.${String(index)}.quantity`] = 'validation.exceeds_available';
      }
    }
  });
  if (form.note.trim().length > NOTE_MAX) issues.note = 'validation.too_long';
  return issues;
}

export function transferBody(form: TransferForm): Record<string, unknown> {
  return {
    source_warehouse_id: form.source_warehouse_id,
    destination_warehouse_id: form.destination_warehouse_id,
    lines: form.lines.map((line) => ({
      product_id: line.product_id,
      quantity: normaliseQuantity(line.quantity) ?? line.quantity.trim(),
    })),
    ...(form.note.trim() === '' ? {} : { note: form.note.trim() }),
  };
}

/** A fresh key per transfer dialog, so a retried submit never moves stock twice. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** STOCK_INSUFFICIENT: what the source held when the server refused. */
export function insufficientDetail(
  error: ApiError,
): { readonly productId: string; readonly available: string; readonly requested: string } | null {
  const productId = error.fields.product_id?.[0];
  const available = error.fields.available?.[0];
  const requested = error.fields.requested?.[0];
  return productId === undefined || available === undefined || requested === undefined
    ? null
    : { productId, available, requested };
}
