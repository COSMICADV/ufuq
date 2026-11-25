import { Decimal } from '@ufuq/money';
import { describe, expect, it } from 'vitest';

import {
  cancellable,
  orderTotals,
  percentOf,
  priceLine,
  roleAllows,
  shiftMinutes,
  transitionAction,
} from './restaurant-rules.js';

const d = (value: string): Decimal => Decimal.parse(value, 2);

describe('restaurant pricing', () => {
  it('prices a line from its size and extras', () => {
    const line = priceLine({
      basePrice: d('85.00'),
      optionPrices: [d('15.00'), d('0.00')],
      quantity: 3,
    });
    expect(line.unitPrice.toString()).toBe('100.00');
    expect(line.lineTotal.toString()).toBe('300.00');
  });

  it('rounds a percentage once, half away from zero', () => {
    expect(percentOf(d('10.05'), d('14.00')).toString()).toBe('1.41'); // 1.407
    expect(percentOf(d('0.25'), d('10.00')).toString()).toBe('0.03'); // 0.025
  });

  it('charges service on dine-in only, and tax on the service too', () => {
    const dineIn = orderTotals({
      lines: [d('200.00')],
      discount: d('20.00'),
      type: 'dine_in',
      taxRate: d('14.00'),
      serviceRate: d('12.00'),
    });
    expect(dineIn).not.toBe('discount_too_large');
    if (dineIn === 'discount_too_large') return;
    expect(dineIn.subtotal.toString()).toBe('200.00');
    expect(dineIn.service.toString()).toBe('21.60');
    expect(dineIn.tax.toString()).toBe('28.22'); // (180 + 21.60) × 14% = 28.224
    expect(dineIn.total.toString()).toBe('229.82');

    const takeaway = orderTotals({
      lines: [d('200.00')],
      discount: d('0.00'),
      type: 'takeaway',
      taxRate: d('14.00'),
      serviceRate: d('12.00'),
    });
    if (takeaway === 'discount_too_large') throw new Error('unexpected');
    expect(takeaway.service.toString()).toBe('0.00');
    expect(takeaway.total.toString()).toBe('228.00');
  });

  it('refuses a discount larger than the subtotal', () => {
    expect(
      orderTotals({
        lines: [d('50.00')],
        discount: d('50.01'),
        type: 'takeaway',
        taxRate: d('0.00'),
        serviceRate: d('0.00'),
      }),
    ).toBe('discount_too_large');
  });
});

describe('order status flow', () => {
  it('lets the kitchen move forward and one step back', () => {
    expect(transitionAction('dine_in', 'new', 'preparing')).toBe('kitchen.update');
    expect(transitionAction('dine_in', 'preparing', 'ready')).toBe('kitchen.update');
    expect(transitionAction('dine_in', 'ready', 'preparing')).toBe('kitchen.update');
    expect(transitionAction('dine_in', 'new', 'served')).toBeNull();
  });

  it('hands a ready order over according to how it leaves', () => {
    expect(transitionAction('dine_in', 'ready', 'served')).toBe('serve');
    expect(transitionAction('takeaway', 'ready', 'picked_up')).toBe('pickup');
    expect(transitionAction('delivery', 'ready', 'delivered')).toBe('deliver');
    expect(transitionAction('takeaway', 'ready', 'served')).toBeNull();
    expect(transitionAction('dine_in', 'served', 'ready')).toBeNull();
  });

  it('cancels only what the kitchen has not finished', () => {
    expect(cancellable('new')).toBe(true);
    expect(cancellable('preparing')).toBe(true);
    expect(cancellable('ready')).toBe(false);
  });

  it('keeps prices away from the kitchen', () => {
    expect(roleAllows('kitchen', 'orders.prices')).toBe(false);
    expect(roleAllows('kitchen', 'kitchen.update')).toBe(true);
    expect(roleAllows('waiter', 'orders.create')).toBe(false);
    expect(roleAllows('cashier', 'kitchen.update')).toBe(false);
  });
});

describe('shifts', () => {
  it('counts scheduled minutes minus the break, across midnight too', () => {
    expect(shiftMinutes('09:00', '17:00', 60)).toBe(420);
    expect(shiftMinutes('18:00', '02:00', 30)).toBe(450);
    expect(shiftMinutes(null, '17:00', 0)).toBe(0);
  });
});
