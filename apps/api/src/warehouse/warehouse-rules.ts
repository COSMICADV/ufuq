/**
 * Warehouse and stock rules — DOCUMENT 17, with the Phase 13 approved
 * decisions recorded in docs/PHASE-13-STATUS.md.
 *
 * Pure: no database. The transfer service and the ledger service call these;
 * the unit tests prove them on their own.
 *
 *   - **Quantities** are DECIMAL(15,3), money DECIMAL(15,2), always through
 *     `@ufuq/money` / exact fractions, never a JavaScript number.
 *   - **Weighted average cost** (DOCUMENT 17 rule 11, the V1 assumption —
 *     OD-13 itself is decided in Phase 14) recalculates on an inbound
 *     movement: `((old_qty × old_avg) + (in_qty × in_cost)) ÷ (old_qty +
 *     in_qty)`, computed exactly and rounded **once** to 0.01, half away from
 *     zero (approved decision). An outbound movement leaves the average as it
 *     is.
 *   - **A transfer** moves stock at the source's stored average cost: the
 *     same `unit_cost` on both legs, so the value leaving the source is the
 *     value arriving at the destination.
 */

import { Decimal, DecimalError } from '@ufuq/money';

import { Fraction } from '../payroll/fraction.js';

export const WAREHOUSE_TYPES = ['main', 'branch', 'store', 'production', 'online'] as const;
export type WarehouseTypeValue = (typeof WAREHOUSE_TYPES)[number];

export const QUANTITY_SCALE = 3;
export const MONEY_SCALE = 2;
/** DECIMAL(15,3): twelve integer digits. */
export const QUANTITY_MAX = '999999999999.999';
/** One transfer moves at most this many product lines (a request-size guard, not a stock rule). */
export const TRANSFER_LINES_MAX = 100;

export function isWarehouseType(value: unknown): value is WarehouseTypeValue {
  return typeof value === 'string' && (WAREHOUSE_TYPES as readonly string[]).includes(value);
}

/** A positive DECIMAL(15,3) quantity, or null if the string is not one. */
export function parseQuantity(value: unknown): Decimal | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = Decimal.parse(value, QUANTITY_SCALE);
    if (!parsed.isPositive()) return null;
    if (parsed.compare(Decimal.parse(QUANTITY_MAX, QUANTITY_SCALE)) > 0) return null;
    return parsed;
  } catch (error) {
    if (error instanceof DecimalError) return null;
    throw error;
  }
}

export function quantity(value: { toString(): string }): Decimal {
  return Decimal.parse(value.toString(), QUANTITY_SCALE);
}

export function money(value: { toString(): string }): Decimal {
  return Decimal.parse(value.toString(), MONEY_SCALE);
}

/** DOCUMENT 17 rule 11 — the new average after an inbound movement, rounded once to 0.01. */
export function weightedAverage(input: {
  readonly oldQuantity: Decimal;
  readonly oldAverage: Decimal;
  readonly inQuantity: Decimal;
  readonly inCost: Decimal;
}): Decimal {
  const oldQty = Fraction.fromDecimal(input.oldQuantity);
  const inQty = Fraction.fromDecimal(input.inQuantity);
  const total = oldQty.add(inQty);
  if (total.isZero()) return input.inCost;
  const value = oldQty
    .multiply(Fraction.fromDecimal(input.oldAverage))
    .add(inQty.multiply(Fraction.fromDecimal(input.inCost)));
  return value.divide(total).toDecimal(MONEY_SCALE, 'nearest');
}

/** Stock value of a balance: quantity × average cost, exact, rounded once to 0.01. */
export function stockValue(rows: readonly { quantity: Decimal; averageCost: Decimal }[]): Decimal {
  return Fraction.sum(
    rows.map((row) =>
      Fraction.fromDecimal(row.quantity).multiply(Fraction.fromDecimal(row.averageCost)),
    ),
  ).toDecimal(MONEY_SCALE, 'nearest');
}

export interface TransferLineInput {
  readonly product_id: string;
  readonly quantity: string;
}

/**
 * DOCUMENT 17 "Validation" for a transfer request, before the database is
 * asked anything: two different locations, each product once, every quantity
 * a positive DECIMAL(15,3).
 */
export function validateTransfer(input: {
  readonly source_warehouse_id: string;
  readonly destination_warehouse_id: string;
  readonly lines: readonly TransferLineInput[];
}): { readonly issues: Record<string, string[]>; readonly quantities: Decimal[] } {
  const issues: Record<string, string[]> = {};
  if (input.source_warehouse_id === input.destination_warehouse_id) {
    issues.destination_warehouse_id = ['same_location'];
  }
  const seen = new Set<string>();
  const quantities: Decimal[] = [];
  input.lines.forEach((line, index) => {
    if (seen.has(line.product_id))
      issues[`lines.${String(index)}.product_id`] = ['duplicate_product'];
    seen.add(line.product_id);
    const parsed = parseQuantity(line.quantity);
    if (parsed === null) issues[`lines.${String(index)}.quantity`] = ['invalid'];
    else quantities.push(parsed);
  });
  return { issues, quantities };
}

/** DOCUMENT 17 rule 5: outbound beyond what is there is refused (no negative-stock setting exists). */
export function isSufficient(available: Decimal, requested: Decimal): boolean {
  return requested.compare(available) <= 0;
}
