/**
 * Inventory rules — DOCUMENT 17, OD-13 (decided A: weighted average cost),
 * and the Phase 14 approved decisions in docs/PHASE-14-STATUS.md.
 *
 * Pure: no database. The movement, product and reconciliation services call
 * these; `inventory-rules.test.ts` proves them on their own.
 *
 *   - **Movement semantics.** `purchase`, `return`, `manual_addition` bring
 *     stock in; `sale`, `damage`, `manual_removal` take it out; `adjustment`
 *     is either, by its sign. The caller sends a positive quantity and the
 *     type decides the sign — except an adjustment, which is signed.
 *     `transfer_in` / `transfer_out` are never accepted here: a transfer is
 *     `POST /warehouses/transfers`, which writes both legs together.
 *   - **Unit cost.** Required on a purchase (DOCUMENT 17 "Validation").
 *     Optional on the other inbound types: when absent, the location's
 *     current average is used while it holds stock, otherwise the product's
 *     cost price — so a correction or a return does not move the average,
 *     and new stock in an empty location is valued at the catalogue cost.
 *     Never accepted on an outbound movement: what leaves is valued at the
 *     location's average. The resolved cost is stored on the movement, so
 *     history keeps the cost it happened at (a later cost-price change
 *     affects only later movements).
 *   - **Stock status** is measured on the product's total across locations
 *     (approved decision): out of stock at ≤ 0, low at ≤ `min_stock`.
 *   - **Crossings** (rules 7, 8): low stock fires when the total falls from
 *     above `min_stock` to at or below it while staying above zero; out of
 *     stock fires when it falls from above zero to zero or below. Neither
 *     fires again while the total stays down; recovering above the line
 *     arms it again.
 *   - **Replay** (rule 3): the cache is rebuilt from the ledger alone, in
 *     ledger order, with the same weighted-average function the movements
 *     used — so the rebuilt average is exactly the one each movement saw.
 */

import { Decimal, DecimalError } from '@ufuq/money';

import {
  MONEY_SCALE,
  QUANTITY_MAX,
  QUANTITY_SCALE,
  weightedAverage,
} from '../warehouse/warehouse-rules.js';

export const DIRECT_MOVEMENT_TYPES = [
  'purchase',
  'sale',
  'adjustment',
  'return',
  'damage',
  'manual_addition',
  'manual_removal',
] as const;
export type DirectMovementType = (typeof DIRECT_MOVEMENT_TYPES)[number];

export const ALL_MOVEMENT_TYPES = [
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
export type MovementTypeValue = (typeof ALL_MOVEMENT_TYPES)[number];

export const INBOUND_TYPES: readonly MovementTypeValue[] = [
  'purchase',
  'return',
  'manual_addition',
  'transfer_in',
];
export const OUTBOUND_TYPES: readonly MovementTypeValue[] = [
  'sale',
  'damage',
  'manual_removal',
  'transfer_out',
];
export const REASON_REQUIRED: readonly MovementTypeValue[] = ['adjustment', 'damage'];

export const REASON_MAX = 1000;
/** DECIMAL(15,2): thirteen integer digits. */
export const MONEY_MAX = '9999999999999.99';

function parseDecimal(value: unknown, scale: number): Decimal | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return Decimal.parse(value.trim(), scale);
  } catch (error) {
    if (error instanceof DecimalError) return null;
    throw error;
  }
}

/** A non-negative DECIMAL(15,2) amount (a price or a unit cost), or null. */
export function parseAmount(value: unknown): Decimal | null {
  const parsed = parseDecimal(value, MONEY_SCALE);
  if (parsed === null || parsed.isNegative()) return null;
  return parsed.compare(Decimal.parse(MONEY_MAX, MONEY_SCALE)) > 0 ? null : parsed;
}

/** A non-negative DECIMAL(15,3) quantity (a minimum stock level), or null. */
export function parseNonNegativeQuantity(value: unknown): Decimal | null {
  const parsed = parseDecimal(value, QUANTITY_SCALE);
  if (parsed === null || parsed.isNegative()) return null;
  return parsed.compare(Decimal.parse(QUANTITY_MAX, QUANTITY_SCALE)) > 0 ? null : parsed;
}

/** A signed, non-zero DECIMAL(15,3) quantity, or null. */
export function parseSignedQuantity(value: unknown): Decimal | null {
  const parsed = parseDecimal(value, QUANTITY_SCALE);
  if (parsed === null || parsed.isZero()) return null;
  return parsed.abs().compare(Decimal.parse(QUANTITY_MAX, QUANTITY_SCALE)) > 0 ? null : parsed;
}

export interface MovementInput {
  readonly type: string;
  readonly quantity: string;
  readonly unit_cost?: string | null | undefined;
  readonly reason?: string | null | undefined;
}

export interface ValidMovement {
  readonly type: DirectMovementType;
  /** Signed: negative leaves the location. */
  readonly quantity: Decimal;
  /** As sent; null when absent (resolved later for inbound). */
  readonly unitCost: Decimal | null;
  readonly reason: string | null;
}

/**
 * DOCUMENT 17 "Validation" for `POST /stock-movements`, before the database
 * is asked anything. Field issues are keyed by the request's own fields.
 */
export function validateMovement(input: MovementInput): {
  readonly issues: Record<string, string[]>;
  readonly movement: ValidMovement | null;
} {
  const issues: Record<string, string[]> = {};
  if (input.type === 'transfer_in' || input.type === 'transfer_out') {
    return { issues: { type: ['use_transfer'] }, movement: null };
  }
  if (!(DIRECT_MOVEMENT_TYPES as readonly string[]).includes(input.type)) {
    return { issues: { type: ['invalid'] }, movement: null };
  }
  const type = input.type as DirectMovementType;

  let signed: Decimal | null = null;
  if (type === 'adjustment') {
    signed = parseSignedQuantity(input.quantity);
  } else {
    const magnitude = parseSignedQuantity(input.quantity);
    if (magnitude !== null && magnitude.isPositive()) {
      signed = OUTBOUND_TYPES.includes(type) ? magnitude.negate() : magnitude;
    }
  }
  if (signed === null) issues.quantity = ['invalid'];

  const outbound = signed !== null && signed.isNegative();
  let unitCost: Decimal | null = null;
  const costSent =
    input.unit_cost !== undefined && input.unit_cost !== null && input.unit_cost !== '';
  if (costSent) {
    if (outbound || OUTBOUND_TYPES.includes(type)) {
      issues.unit_cost = ['not_allowed'];
    } else {
      unitCost = parseAmount(input.unit_cost);
      if (unitCost === null) issues.unit_cost = ['invalid'];
    }
  } else if (type === 'purchase') {
    issues.unit_cost = ['required'];
  }

  const reason =
    typeof input.reason === 'string' && input.reason.trim() !== '' ? input.reason.trim() : null;
  if (REASON_REQUIRED.includes(type) && reason === null) issues.reason = ['required'];
  if (reason !== null && reason.length > REASON_MAX) issues.reason = ['too_long'];

  if (Object.keys(issues).length > 0 || signed === null) return { issues, movement: null };
  return { issues, movement: { type, quantity: signed, unitCost, reason } };
}

/**
 * The cost an inbound movement is recorded at: the one sent; otherwise the
 * location's average while it holds stock; otherwise the product's cost price.
 */
export function resolveInboundCost(input: {
  readonly sent: Decimal | null;
  readonly locationQuantity: Decimal;
  readonly locationAverage: Decimal;
  readonly costPrice: Decimal;
}): Decimal {
  if (input.sent !== null) return input.sent;
  return input.locationQuantity.isPositive() ? input.locationAverage : input.costPrice;
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

/** DOCUMENT 17 rules 7–8, on the product's total across locations. */
export function stockStatus(total: Decimal, minStock: Decimal): StockStatus {
  if (!total.isPositive()) return 'out_of_stock';
  if (total.compare(minStock) <= 0) return 'low_stock';
  return 'in_stock';
}

/** Which thresholds a change of the product total crosses downward (once per crossing). */
export function crossings(
  before: Decimal,
  after: Decimal,
  minStock: Decimal,
): { readonly lowStock: boolean; readonly outOfStock: boolean } {
  const outOfStock = before.isPositive() && !after.isPositive();
  const lowStock =
    before.compare(minStock) > 0 && after.compare(minStock) <= 0 && after.isPositive();
  return { lowStock, outOfStock };
}

export interface LedgerRow {
  readonly id: string;
  readonly quantity: Decimal;
  readonly unitCost: Decimal | null;
  readonly balanceAfter: Decimal;
}

export interface Replayed {
  readonly quantity: Decimal;
  readonly averageCost: Decimal;
  /** Movements whose stored `balance_after` does not follow the running balance. */
  readonly chainBreaks: readonly string[];
}

/**
 * Rebuild a (product, location) balance from its movements, in ledger order:
 * the quantity is their sum, the average follows rule 11 on every inbound
 * movement at its recorded cost, and each stored `balance_after` is checked
 * against the running balance.
 */
export function replay(rows: readonly LedgerRow[]): Replayed {
  let qty = Decimal.zero(QUANTITY_SCALE);
  let avg = Decimal.zero(MONEY_SCALE);
  const chainBreaks: string[] = [];
  for (const row of rows) {
    if (row.quantity.isPositive()) {
      avg = weightedAverage({
        oldQuantity: qty,
        oldAverage: avg,
        inQuantity: row.quantity,
        inCost: row.unitCost ?? avg,
      });
    }
    qty = qty.add(row.quantity);
    if (!qty.equals(row.balanceAfter)) chainBreaks.push(row.id);
  }
  return { quantity: qty, averageCost: avg, chainBreaks };
}
