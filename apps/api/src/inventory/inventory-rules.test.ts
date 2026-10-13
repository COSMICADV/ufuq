/**
 * Inventory rules — DOCUMENT 17 rules 5, 7–9, 11, OD-13 (A), DOCUMENT 26
 * (exact decimal assertions only).
 */

import { Decimal } from '@ufuq/money';
import { describe, expect, it } from 'vitest';

import { weightedAverage } from '../warehouse/warehouse-rules.js';

import {
  crossings,
  parseAmount,
  parseNonNegativeQuantity,
  replay,
  resolveInboundCost,
  stockStatus,
  validateMovement,
} from './inventory-rules.js';

const q = (v: string) => Decimal.parse(v, 3);
const m = (v: string) => Decimal.parse(v, 2);

describe('movement semantics (DOCUMENT 17 "Movement types")', () => {
  it('inbound types are positive, outbound types negative; the sender gives a magnitude', () => {
    for (const type of ['purchase', 'return', 'manual_addition']) {
      const result = validateMovement({ type, quantity: '5', unit_cost: '10.00', reason: 'x' });
      expect(result.movement?.quantity.toString(), type).toBe('5.000');
    }
    for (const type of ['sale', 'damage', 'manual_removal']) {
      const result = validateMovement({ type, quantity: '5', reason: 'broken' });
      expect(result.movement?.quantity.toString(), type).toBe('-5.000');
    }
    expect(validateMovement({ type: 'sale', quantity: '-5' }).issues).toEqual({
      quantity: ['invalid'],
    });
  });

  it('an adjustment is signed and needs a reason (rule 9), as damage does', () => {
    expect(
      validateMovement({
        type: 'adjustment',
        quantity: '-2.5',
        reason: 'Count',
      }).movement?.quantity.toString(),
    ).toBe('-2.500');
    expect(
      validateMovement({
        type: 'adjustment',
        quantity: '2.5',
        reason: 'Count',
      }).movement?.quantity.toString(),
    ).toBe('2.500');
    expect(validateMovement({ type: 'adjustment', quantity: '1' }).issues).toEqual({
      reason: ['required'],
    });
    expect(validateMovement({ type: 'damage', quantity: '1', reason: '  ' }).issues).toEqual({
      reason: ['required'],
    });
  });

  it('quantity ≠ 0, at most three decimals; transfers are refused here', () => {
    for (const bad of ['0', '-0', '0.000', '1.0001', 'abc', '', '1e3', '1000000000000']) {
      expect(
        validateMovement({ type: 'manual_addition', quantity: bad }).issues.quantity,
        bad,
      ).toEqual(['invalid']);
    }
    expect(
      validateMovement({ type: 'adjustment', quantity: '0', reason: 'x' }).issues.quantity,
    ).toEqual(['invalid']);
    expect(validateMovement({ type: 'transfer_in', quantity: '1' }).issues).toEqual({
      type: ['use_transfer'],
    });
    expect(validateMovement({ type: 'transfer_out', quantity: '1' }).issues).toEqual({
      type: ['use_transfer'],
    });
  });

  it('unit cost: required on a purchase, refused on outbound, exact to the piastre', () => {
    expect(validateMovement({ type: 'purchase', quantity: '1' }).issues).toEqual({
      unit_cost: ['required'],
    });
    expect(validateMovement({ type: 'sale', quantity: '1', unit_cost: '5.00' }).issues).toEqual({
      unit_cost: ['not_allowed'],
    });
    expect(
      validateMovement({ type: 'adjustment', quantity: '-1', unit_cost: '5', reason: 'x' }).issues,
    ).toEqual({
      unit_cost: ['not_allowed'],
    });
    expect(
      validateMovement({ type: 'purchase', quantity: '1', unit_cost: '5.001' }).issues,
    ).toEqual({ unit_cost: ['invalid'] });
    expect(validateMovement({ type: 'purchase', quantity: '1', unit_cost: '-5' }).issues).toEqual({
      unit_cost: ['invalid'],
    });
    expect(validateMovement({ type: 'return', quantity: '1' }).movement?.unitCost).toBeNull();
  });

  it('prices and minimum stock are non-negative exact decimals', () => {
    expect(parseAmount('0')?.toString()).toBe('0.00');
    expect(parseAmount('149.99')?.toString()).toBe('149.99');
    for (const bad of ['-0.01', '1.001', 'x', '']) expect(parseAmount(bad), bad).toBeNull();
    expect(parseNonNegativeQuantity('12.5')?.toString()).toBe('12.500');
    expect(parseNonNegativeQuantity('-1')).toBeNull();
  });
});

describe('the cost an inbound movement is recorded at', () => {
  it('the cost sent; else the location average while it holds stock; else the cost price', () => {
    expect(
      resolveInboundCost({
        sent: m('12.00'),
        locationQuantity: q('5'),
        locationAverage: m('10.00'),
        costPrice: m('9.00'),
      }).toString(),
    ).toBe('12.00');
    expect(
      resolveInboundCost({
        sent: null,
        locationQuantity: q('5'),
        locationAverage: m('10.00'),
        costPrice: m('9.00'),
      }).toString(),
    ).toBe('10.00');
    expect(
      resolveInboundCost({
        sent: null,
        locationQuantity: q('0'),
        locationAverage: m('10.00'),
        costPrice: m('9.00'),
      }).toString(),
    ).toBe('9.00');
    expect(
      resolveInboundCost({
        sent: null,
        locationQuantity: q('-3'),
        locationAverage: m('10.00'),
        costPrice: m('9.00'),
      }).toString(),
    ).toBe('9.00');
  });
});

describe('weighted average (OD-13 A) — negative balances', () => {
  it('stock arriving at an empty or negative location takes its own cost', () => {
    expect(
      weightedAverage({
        oldQuantity: q('0'),
        oldAverage: m('50.00'),
        inQuantity: q('3'),
        inCost: m('20.00'),
      }).toString(),
    ).toBe('20.00');
    expect(
      weightedAverage({
        oldQuantity: q('-4'),
        oldAverage: m('50.00'),
        inQuantity: q('10'),
        inCost: m('20.00'),
      }).toString(),
    ).toBe('20.00');
  });
});

describe('stock status and crossings (rules 7, 8) on the product total', () => {
  it('out at ≤ 0, low at ≤ min, otherwise in stock', () => {
    expect(stockStatus(q('0'), q('10'))).toBe('out_of_stock');
    expect(stockStatus(q('-1'), q('10'))).toBe('out_of_stock');
    expect(stockStatus(q('10'), q('10'))).toBe('low_stock');
    expect(stockStatus(q('10.001'), q('10'))).toBe('in_stock');
    expect(stockStatus(q('0.001'), q('0'))).toBe('in_stock');
  });

  it('fires once per downward crossing, never while it stays below, again after recovery', () => {
    const min = q('10');
    expect(crossings(q('15'), q('9'), min)).toEqual({ lowStock: true, outOfStock: false });
    expect(crossings(q('9'), q('8'), min)).toEqual({ lowStock: false, outOfStock: false });
    expect(crossings(q('8'), q('13'), min)).toEqual({ lowStock: false, outOfStock: false });
    expect(crossings(q('13'), q('10'), min)).toEqual({ lowStock: true, outOfStock: false });
    expect(crossings(q('10'), q('0'), min)).toEqual({ lowStock: false, outOfStock: true });
    expect(crossings(q('0'), q('-2'), min)).toEqual({ lowStock: false, outOfStock: false });
    // Straight from above the line to zero is the out-of-stock event alone.
    expect(crossings(q('50'), q('0'), min)).toEqual({ lowStock: false, outOfStock: true });
  });
});

describe('replay — the cache rebuilt from the ledger (rule 3)', () => {
  const row = (id: string, qty: string, cost: string | null, after: string) => ({
    id,
    quantity: q(qty),
    unitCost: cost === null ? null : m(cost),
    balanceAfter: q(after),
  });

  it('sums the quantity and replays the average exactly, rounding at each inbound step as the movements did', () => {
    const rebuilt = replay([
      row('a', '10', '30.00', '10'),
      row('b', '20', '45.00', '30'),
      row('c', '-12.5', '40.00', '17.5'),
      // (17.5 × 40 + 2.25 × 41.37) ÷ 19.75 = 793.0825 ÷ 19.75 = 40.1560… → 40.16
      row('d', '2.25', '41.37', '19.75'),
    ]);
    expect(rebuilt.quantity.toString()).toBe('19.750');
    expect(rebuilt.averageCost.toString()).toBe('40.16');
    expect(rebuilt.chainBreaks).toEqual([]);
  });

  it('reports a stored balance_after that does not follow the ledger', () => {
    const rebuilt = replay([row('a', '10', '5.00', '10'), row('b', '-3', '5.00', '6')]);
    expect(rebuilt.quantity.toString()).toBe('7.000');
    expect(rebuilt.chainBreaks).toEqual(['b']);
  });

  it('an empty ledger is a zero balance', () => {
    const rebuilt = replay([]);
    expect([rebuilt.quantity.toString(), rebuilt.averageCost.toString()]).toEqual([
      '0.000',
      '0.00',
    ]);
  });
});
