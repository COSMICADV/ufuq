/**
 * Exact rational arithmetic for the payroll engine — DOCUMENT 15 rules 13–14.
 *
 * A daily wage is a division (20,000 ÷ 26), and a fixed-scale decimal can only
 * hold it by rounding. DOCUMENT 15 rule 14 allows rounding once, at the end,
 * so every intermediate amount is kept here as an exact fraction of two
 * bigints. Nothing passes through a JavaScript `number`. `toDecimal` is the
 * single place a fraction becomes a stored amount, and it always names its
 * rounding.
 */

import { Decimal } from '@ufuq/money';

export type FractionRounding = 'nearest' | 'up' | 'down' | 'exact';

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

export class Fraction {
  private constructor(
    readonly numerator: bigint,
    readonly denominator: bigint,
  ) {}

  static of(numerator: bigint, denominator: bigint = 1n): Fraction {
    if (denominator === 0n) {
      throw new RangeError('Division by zero.');
    }
    const sign = denominator < 0n ? -1n : 1n;
    const n = numerator * sign;
    const d = denominator * sign;
    const divisor = gcd(n, d);
    return divisor === 0n ? new Fraction(0n, 1n) : new Fraction(n / divisor, d / divisor);
  }

  static integer(value: number | bigint): Fraction {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new RangeError(`Not a safe integer: ${String(value)}`);
    }
    return Fraction.of(BigInt(value));
  }

  static zero(): Fraction {
    return Fraction.of(0n);
  }

  static fromDecimal(value: Decimal): Fraction {
    return Fraction.of(value.units, 10n ** BigInt(value.scale));
  }

  /** A decimal string such as `"20000.00"` or `"1.5"`. */
  static parse(value: string): Fraction {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
    if (match === null) {
      throw new RangeError(`Not a decimal string: "${value}"`);
    }
    const fraction = match[3] ?? '';
    const units = BigInt(`${match[1] ?? ''}${match[2] ?? '0'}${fraction}`);
    return Fraction.of(units, 10n ** BigInt(fraction.length));
  }

  /** The `"n/d"` form the snapshot stores, so an exact value survives JSON. */
  static fromJSON(value: string): Fraction {
    const [n, d] = value.split('/');
    if (n === undefined || d === undefined || !/^-?\d+$/.test(n) || !/^\d+$/.test(d)) {
      throw new RangeError(`Not a fraction: "${value}"`);
    }
    return Fraction.of(BigInt(n), BigInt(d));
  }

  add(other: Fraction): Fraction {
    return Fraction.of(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  subtract(other: Fraction): Fraction {
    return this.add(other.negate());
  }

  multiply(other: Fraction): Fraction {
    return Fraction.of(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  multiplyByInteger(value: number | bigint): Fraction {
    return this.multiply(Fraction.integer(value));
  }

  divide(other: Fraction): Fraction {
    if (other.numerator === 0n) {
      throw new RangeError('Division by zero.');
    }
    return Fraction.of(this.numerator * other.denominator, this.denominator * other.numerator);
  }

  divideByInteger(value: number | bigint): Fraction {
    return this.divide(Fraction.integer(value));
  }

  negate(): Fraction {
    return Fraction.of(-this.numerator, this.denominator);
  }

  isNegative(): boolean {
    return this.numerator < 0n;
  }

  isZero(): boolean {
    return this.numerator === 0n;
  }

  compare(other: Fraction): -1 | 0 | 1 {
    const left = this.numerator * other.denominator;
    const right = other.numerator * this.denominator;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  static sum(values: readonly Fraction[]): Fraction {
    return values.reduce((total, value) => total.add(value), Fraction.zero());
  }

  /**
   * The value at a fixed scale. `nearest` is half away from zero; `up` and
   * `down` are toward positive and negative infinity; `exact` throws unless
   * the value is representable at the scale.
   */
  toDecimal(scale: number, mode: FractionRounding): Decimal {
    const factor = 10n ** BigInt(scale);
    const n = this.numerator * factor;
    const d = this.denominator;
    let quotient = n / d;
    const remainder = n % d;
    if (remainder !== 0n) {
      switch (mode) {
        case 'exact':
          throw new RangeError(`${this.toJSON()} is not exact at scale ${String(scale)}.`);
        case 'up':
          if (n > 0n) quotient += 1n;
          break;
        case 'down':
          if (n < 0n) quotient -= 1n;
          break;
        case 'nearest': {
          const twice = (remainder < 0n ? -remainder : remainder) * 2n;
          if (twice >= d) quotient += n > 0n ? 1n : -1n;
          break;
        }
      }
    }
    return Decimal.fromUnits(quotient, scale);
  }

  toJSON(): string {
    return `${this.numerator.toString()}/${this.denominator.toString()}`;
  }
}
