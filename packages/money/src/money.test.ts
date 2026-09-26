import { describe, expect, it } from 'vitest';

import { Decimal, DecimalError } from './decimal.js';
import { CurrencyMismatchError, Money, Quantity, rate } from './money.js';

describe('Decimal — construction', () => {
  it('parses a decimal string exactly', () => {
    expect(Decimal.parse('20000.00', 2).toString()).toBe('20000.00');
    expect(Decimal.parse('-0.05', 2).toString()).toBe('-0.05');
    expect(Decimal.parse('769', 2).toString()).toBe('769.00');
  });

  it('refuses a JavaScript number', () => {
    // @ts-expect-error a number is not an accepted input — RULE 17
    expect(() => Decimal.parse(0.1 + 0.2, 2)).toThrow(DecimalError);
  });

  it('refuses to silently drop decimal places', () => {
    expect(() => Decimal.parse('769.2307', 2)).toThrow(DecimalError);
  });

  it('refuses values beyond DECIMAL(15, s)', () => {
    expect(() => Decimal.parse('99999999999999.99', 2)).toThrow(DecimalError);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '1,000.00', '1e3', 'abc', '١٢٣']) {
      expect(() => Decimal.parse(bad, 2)).toThrow(DecimalError);
    }
  });
});

describe('Decimal — arithmetic without floating point', () => {
  it('adds the classic floating-point failure exactly', () => {
    const sum = Decimal.parse('0.10', 2).add(Decimal.parse('0.20', 2));
    expect(sum.toString()).toBe('0.30');
  });

  it('refuses to mix scales', () => {
    expect(() => Decimal.parse('1.00', 2).add(Decimal.parse('1.000', 3))).toThrow(DecimalError);
  });

  it('requires an explicit rounding mode for an inexact result', () => {
    const salary = Decimal.parse('20000.00', 2);
    expect(() => salary.divideByInteger(26)).toThrow(DecimalError);
  });
});

describe('Decimal — rounding policies (salary_policies.rounding)', () => {
  const salary = Decimal.parse('20000.00', 2);

  it('nearest rounds half away from zero', () => {
    // DOCUMENT 15: 20,000 ÷ 26 = 769.23
    expect(salary.divideByInteger(26, 'nearest').toString()).toBe('769.23');
    expect(Decimal.parse('0.05', 2).divideByInteger(2, 'nearest').toString()).toBe('0.03');
    expect(Decimal.parse('-0.05', 2).divideByInteger(2, 'nearest').toString()).toBe('-0.03');
  });

  it('up rounds toward positive infinity', () => {
    expect(salary.divideByInteger(26, 'up').toString()).toBe('769.24');
    expect(Decimal.parse('-1.00', 2).divideByInteger(3, 'up').toString()).toBe('-0.33');
  });

  it('down rounds toward negative infinity', () => {
    expect(salary.divideByInteger(26, 'down').toString()).toBe('769.23');
    expect(Decimal.parse('-1.00', 2).divideByInteger(3, 'down').toString()).toBe('-0.34');
  });

  it('none refuses an inexact result rather than guessing', () => {
    expect(() => salary.divideByInteger(26, 'none')).toThrow(DecimalError);
    expect(salary.divideByInteger(25, 'none').toString()).toBe('800.00');
  });

  it('applies a whole-pound policy once, at the end', () => {
    const value = Decimal.parse('19499.60', 2);
    expect(value.applyPolicy('nearest').toString()).toBe('19500.00');
    expect(value.applyPolicy('down').toString()).toBe('19499.00');
    expect(value.applyPolicy('up').toString()).toBe('19500.00');
    expect(value.applyPolicy('none').toString()).toBe('19499.60');
  });
});

describe('Money', () => {
  it('carries an explicit currency into the API payload (DOCUMENT 08 §1)', () => {
    expect(Money.of('20000.00', 'EGP').toJSON()).toEqual({
      amount: '20000.00',
      currency: 'EGP',
    });
  });

  it('refuses to combine currencies (assumption A-02)', () => {
    expect(() => Money.of('1.00', 'EGP').add(Money.of('1.00', 'USD'))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('rejects an invalid currency code', () => {
    expect(() => Money.of('1.00', 'egp')).toThrow(DecimalError);
  });

  it('computes the DOCUMENT 15 worked example exactly', () => {
    // base 20,000 − 200 late − 500 unpaid leave − 300 deduction + 500 bonus
    const base = Money.of('20000.00', 'EGP');
    const net = base
      .subtract(Money.of('200.00', 'EGP'))
      .subtract(Money.of('500.00', 'EGP'))
      .subtract(Money.of('300.00', 'EGP'))
      .add(Money.of('500.00', 'EGP'));
    expect(net.toString()).toBe('19500.00');
  });

  it('derives a daily wage on the fixed_days basis', () => {
    const dailyWage = Money.of('20000.00', 'EGP').dividedBy(26, 'nearest');
    expect(dailyWage.toString()).toBe('769.23');
  });

  it('applies an overtime multiplier as a rate', () => {
    const hourly = Money.of('96.15', 'EGP');
    expect(hourly.timesRate(rate('1.5000')).toString()).toBe('144.23');
  });

  it('reports a negative net so the caller can block it (DOCUMENT 15 rule 7)', () => {
    const net = Money.of('1000.00', 'EGP').subtract(Money.of('1500.00', 'EGP'));
    expect(net.isNegative()).toBe(true);
    expect(net.toString()).toBe('-500.00');
  });

  it('sums a list of deductions', () => {
    const total = Money.sum(
      [Money.of('200.00', 'EGP'), Money.of('500.00', 'EGP'), Money.of('300.00', 'EGP')],
      'EGP',
    );
    expect(total.toString()).toBe('1000.00');
  });
});

describe('Quantity', () => {
  it('supports fractional units at DECIMAL(15,3) (DOCUMENT 17)', () => {
    expect(Quantity.of('12.500').add(Quantity.of('0.750')).toString()).toBe('13.250');
  });

  it('replays a movement ledger to the cached balance (invariant 4)', () => {
    const movements = [
      Quantity.of('100.000'),
      Quantity.of('-30.500'),
      Quantity.of('12.250'),
      Quantity.of('-1.750'),
    ];
    expect(Quantity.sum(movements).toString()).toBe('80.000');
  });

  it('detects a negative balance so the policy check can block it', () => {
    expect(Quantity.of('10.000').subtract(Quantity.of('12.000')).isNegative()).toBe(true);
  });
});

describe('weighted average cost (DOCUMENT 17 rule 11)', () => {
  it('recalculates on an inbound movement', () => {
    // ((100 × 10.00) + (50 × 13.00)) ÷ 150 = 11.00
    const oldValue = Money.of('10.00', 'EGP').times(100);
    const inboundValue = Money.of('13.00', 'EGP').times(50);
    const newAverage = oldValue.add(inboundValue).dividedBy(150, 'nearest');
    expect(newAverage.toString()).toBe('11.00');
  });
});
