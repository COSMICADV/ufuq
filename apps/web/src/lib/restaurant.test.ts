import { describe, expect, it } from 'vitest';

import { cartTotals, fromMinor, isMoney, percentMinor, toMinor } from './restaurant';

describe('restaurant cart preview', () => {
  it('converts money strings without floats', () => {
    expect(toMinor('12.5')).toBe(1250n);
    expect(toMinor('0.05')).toBe(5n);
    expect(toMinor('abc')).toBe(0n);
    expect(fromMinor(123456n)).toBe('1234.56');
    expect(isMoney('10.123')).toBe(false);
  });

  it('rounds a percentage half away from zero, as the server does', () => {
    expect(fromMinor(percentMinor(toMinor('10.05'), '14.00'))).toBe('1.41');
    expect(fromMinor(percentMinor(toMinor('0.25'), '10.00'))).toBe('0.03');
  });

  it('matches the server for a dine-in order with discount, service and VAT', () => {
    // Same figures as the API test: 435.00, service 12%, VAT 14% → 555.41.
    const totals = cartTotals({
      lines: [toMinor('370.00'), toMinor('65.00')],
      discount: '',
      type: 'dine_in',
      taxRate: '14.00',
      serviceRate: '12.00',
    });
    expect(totals).toMatchObject({
      subtotal: '435.00',
      service: '52.20',
      tax: '68.21',
      total: '555.41',
      discountTooLarge: false,
    });
    const discounted = cartTotals({
      lines: [toMinor('200.00')],
      discount: '20',
      type: 'dine_in',
      taxRate: '14.00',
      serviceRate: '12.00',
    });
    expect(discounted.total).toBe('229.82');
  });

  it('charges no service on take-away and flags a discount above the subtotal', () => {
    expect(
      cartTotals({
        lines: [toMinor('200.00')],
        discount: '0',
        type: 'takeaway',
        taxRate: '14.00',
        serviceRate: '12.00',
      }).total,
    ).toBe('228.00');
    expect(
      cartTotals({
        lines: [toMinor('50.00')],
        discount: '60',
        type: 'takeaway',
        taxRate: '0',
        serviceRate: '0',
      }).discountTooLarge,
    ).toBe(true);
  });
});
