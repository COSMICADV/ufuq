/**
 * Money and Quantity.
 *
 * DOCUMENT 06 §2 — money is DECIMAL(15,2) with an explicit currency;
 * stock quantity is DECIMAL(15,3) so metres, kilograms, and litres work.
 * DOCUMENT 08 §1 — money crosses the API as a string plus a currency field.
 */

import { Decimal, DecimalError, type RoundingMode } from './decimal.js';

export const MONEY_SCALE = 2;
export const QUANTITY_SCALE = 3;
export const RATE_SCALE = 4;

/** ISO 4217 alphabetic code. One currency per company in V1 (assumption A-02). */
export type CurrencyCode = string;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export interface MoneyJson {
  readonly amount: string;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(left: CurrencyCode, right: CurrencyCode) {
    super(
      `Cannot combine ${left} with ${right}. Multi-currency arithmetic is out of V1 scope (assumption A-02).`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  readonly value: Decimal;
  readonly currency: CurrencyCode;

  private constructor(value: Decimal, currency: CurrencyCode) {
    this.value = value;
    this.currency = currency;
  }

  private static assertCurrency(currency: CurrencyCode): void {
    if (!CURRENCY_PATTERN.test(currency)) {
      throw new DecimalError(`Not an ISO 4217 currency code: "${currency}"`);
    }
  }

  static of(amount: string, currency: CurrencyCode): Money {
    Money.assertCurrency(currency);
    return new Money(Decimal.parse(amount, MONEY_SCALE), currency);
  }

  static zero(currency: CurrencyCode): Money {
    Money.assertCurrency(currency);
    return new Money(Decimal.zero(MONEY_SCALE), currency);
  }

  private sameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.value.add(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.value.subtract(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negate(), this.currency);
  }

  /** Multiply by a count — days absent, late incidents, units sold. */
  times(count: bigint | number): Money {
    return new Money(this.value.multiplyByInteger(count), this.currency);
  }

  /** Apply a rate — an overtime multiplier or a performance weight. */
  timesRate(rate: Decimal, mode: RoundingMode = 'nearest'): Money {
    return new Money(this.value.multiply(rate, mode), this.currency);
  }

  /** Monthly salary ÷ working days. The rounding mode comes from salary_policies. */
  dividedBy(divisor: bigint | number, mode: RoundingMode = 'nearest'): Money {
    return new Money(this.value.divideByInteger(divisor, mode), this.currency);
  }

  /** Apply the company's rounding policy once, at the end (DOCUMENT 15 rule 14). */
  applyRoundingPolicy(mode: RoundingMode): Money {
    return new Money(this.value.applyPolicy(mode, 0), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.sameCurrency(other);
    return this.value.compare(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toString(): string {
    return this.value.toString();
  }

  toJSON(): MoneyJson {
    return { amount: this.value.toString(), currency: this.currency };
  }

  static sum(values: readonly Money[], currency: CurrencyCode): Money {
    return values.reduce<Money>((total, value) => total.add(value), Money.zero(currency));
  }
}

/** Stock quantity — DECIMAL(15,3), signed, since movements carry direction. */
export class Quantity {
  readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value;
  }

  static of(amount: string): Quantity {
    return new Quantity(Decimal.parse(amount, QUANTITY_SCALE));
  }

  static zero(): Quantity {
    return new Quantity(Decimal.zero(QUANTITY_SCALE));
  }

  add(other: Quantity): Quantity {
    return new Quantity(this.value.add(other.value));
  }

  subtract(other: Quantity): Quantity {
    return new Quantity(this.value.subtract(other.value));
  }

  negate(): Quantity {
    return new Quantity(this.value.negate());
  }

  compare(other: Quantity): -1 | 0 | 1 {
    return this.value.compare(other.value);
  }

  equals(other: Quantity): boolean {
    return this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toString(): string {
    return this.value.toString();
  }

  toJSON(): string {
    return this.value.toString();
  }

  static sum(values: readonly Quantity[]): Quantity {
    return values.reduce<Quantity>((total, value) => total.add(value), Quantity.zero());
  }
}

/** A rate, weight, or multiplier — never money, never a quantity. */
export function rate(value: string): Decimal {
  return Decimal.parse(value, RATE_SCALE);
}
