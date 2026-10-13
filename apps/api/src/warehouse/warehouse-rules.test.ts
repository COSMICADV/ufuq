/**
 * Warehouse rules — DOCUMENT 17 "Validation", rules 5 and 11, DOCUMENT 26
 * (exact decimal assertions only).
 */

import { Decimal } from '@ufuq/money';
import { describe, expect, it } from 'vitest';

import {
  isSufficient,
  isWarehouseType,
  parseQuantity,
  stockValue,
  validateTransfer,
  WAREHOUSE_TYPES,
  weightedAverage,
} from './warehouse-rules.js';

const q = (v: string) => Decimal.parse(v, 3);
const m = (v: string) => Decimal.parse(v, 2);

describe('warehouse types — one stock model', () => {
  it('accepts exactly the five documented types, online among them', () => {
    expect([...WAREHOUSE_TYPES]).toEqual(['main', 'branch', 'store', 'production', 'online']);
    for (const type of WAREHOUSE_TYPES) expect(isWarehouseType(type)).toBe(true);
    for (const type of ['marketplace', 'Main', '', null, 3])
      expect(isWarehouseType(type)).toBe(false);
  });
});

describe('quantities are exact DECIMAL(15,3)', () => {
  it('parses positive quantities up to three decimals and refuses everything else', () => {
    expect(parseQuantity('12.5')?.toString()).toBe('12.500');
    expect(parseQuantity('0.001')?.toString()).toBe('0.001');
    expect(parseQuantity('999999999999.999')?.toString()).toBe('999999999999.999');
    for (const bad of ['0', '-1', '1.0001', '1e3', 'abc', '', '1000000000000']) {
      expect(parseQuantity(bad), bad).toBeNull();
    }
    expect(parseQuantity(12.5)).toBeNull();
  });

  it('insufficient stock: requested beyond available is refused, equal is allowed', () => {
    expect(isSufficient(q('120.000'), q('120.000'))).toBe(true);
    expect(isSufficient(q('120.000'), q('120.001'))).toBe(false);
    expect(isSufficient(q('0'), q('0.001'))).toBe(false);
  });
});

describe('weighted average cost (DOCUMENT 17 rule 11), rounded once', () => {
  it('an empty location takes the inbound cost', () => {
    expect(
      weightedAverage({
        oldQuantity: q('0'),
        oldAverage: m('0'),
        inQuantity: q('5'),
        inCost: m('35.00'),
      }).toString(),
    ).toBe('35.00');
  });

  it('((old × avg) + (in × cost)) ÷ (old + in), exact before the one rounding', () => {
    // (10 × 30 + 20 × 45) ÷ 30 = 40
    expect(
      weightedAverage({
        oldQuantity: q('10'),
        oldAverage: m('30.00'),
        inQuantity: q('20'),
        inCost: m('45.00'),
      }).toString(),
    ).toBe('40.00');
    // (1 × 10 + 2 × 10.01) ÷ 3 = 10.00666… → 10.01
    expect(
      weightedAverage({
        oldQuantity: q('1'),
        oldAverage: m('10.00'),
        inQuantity: q('2'),
        inCost: m('10.01'),
      }).toString(),
    ).toBe('10.01');
    // (2 × 10 + 1 × 10.01) ÷ 3 = 10.00333… → 10.00
    expect(
      weightedAverage({
        oldQuantity: q('2'),
        oldAverage: m('10.00'),
        inQuantity: q('1'),
        inCost: m('10.01'),
      }).toString(),
    ).toBe('10.00');
    // half away from zero: (1 × 0.01 + 1 × 0.02) ÷ 2 = 0.015 → 0.02
    expect(
      weightedAverage({
        oldQuantity: q('1'),
        oldAverage: m('0.01'),
        inQuantity: q('1'),
        inCost: m('0.02'),
      }).toString(),
    ).toBe('0.02');
  });

  it('fractional units (metres, kilograms) keep their precision', () => {
    // (120.5 × 35 + 20.25 × 40) ÷ 140.75 = 5027.5 ÷ 140.75 = 35.719…
    expect(
      weightedAverage({
        oldQuantity: q('120.500'),
        oldAverage: m('35.00'),
        inQuantity: q('20.250'),
        inCost: m('40.00'),
      }).toString(),
    ).toBe('35.72');
  });

  it('stock value is Σ quantity × average, rounded once', () => {
    expect(stockValue([{ quantity: q('120.500'), averageCost: m('35.00') }]).toString()).toBe(
      '4217.50',
    );
    // 0.333 × 0.01 three times = 0.00999 → 0.01 (rounding each first would be 0.00)
    const row = { quantity: q('0.333'), averageCost: m('0.01') };
    expect(stockValue([row, row, row]).toString()).toBe('0.01');
  });
});

describe('transfer validation (DOCUMENT 17)', () => {
  const ok = {
    source_warehouse_id: 'a',
    destination_warehouse_id: 'b',
    lines: [{ product_id: 'p1', quantity: '10.5' }],
  };

  it('a valid transfer has no issues and exact quantities', () => {
    const result = validateTransfer(ok);
    expect(result.issues).toEqual({});
    expect(result.quantities.map(String)).toEqual(['10.500']);
  });

  it('refuses the same location, a repeated product and a bad quantity', () => {
    expect(validateTransfer({ ...ok, destination_warehouse_id: 'a' }).issues).toEqual({
      destination_warehouse_id: ['same_location'],
    });
    expect(
      validateTransfer({
        ...ok,
        lines: [
          { product_id: 'p1', quantity: '1' },
          { product_id: 'p1', quantity: '2' },
        ],
      }).issues,
    ).toEqual({ 'lines.1.product_id': ['duplicate_product'] });
    expect(
      validateTransfer({ ...ok, lines: [{ product_id: 'p1', quantity: '0' }] }).issues,
    ).toEqual({
      'lines.0.quantity': ['invalid'],
    });
  });
});
