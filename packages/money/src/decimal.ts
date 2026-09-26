/**
 * Fixed-precision decimal arithmetic.
 *
 * DOCUMENT 01 NFR-04 · DOCUMENT 06 §1.2 · DOCUMENT 15 · DOCUMENT 27 RULE 17.
 *
 * Values are held as a bigint of minor units plus a fixed scale. No value ever
 * passes through a JavaScript `number`, so no binary floating point error can
 * enter a salary or a stock balance.
 *
 * Scales in use, per the database specification:
 *   money      DECIMAL(15,2)  → scale 2
 *   quantity   DECIMAL(15,3)  → scale 3
 *   percentage DECIMAL(5,2)   → scale 2
 */

/**
 * Rounding policies. The four names map directly onto
 * `salary_policies.rounding` in DOCUMENT 06 §3.22.
 *
 *   none    — the operation must be exact; an inexact result throws.
 *   nearest — half away from zero.
 *   up      — toward positive infinity.
 *   down    — toward negative infinity.
 */
export type RoundingMode = 'none' | 'nearest' | 'up' | 'down';

/** DECIMAL(15, s): fifteen significant digits in total. */
const MAX_PRECISION = 15;

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function roundDivide(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new DecimalError('Division by zero.');
  }

  // Normalise the sign onto the numerator so the policies below read plainly.
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const quotient = n / d;
  const remainder = n % d;

  if (remainder === 0n) {
    return quotient;
  }

  switch (mode) {
    case 'none':
      throw new DecimalError(
        'Result is not exact at this scale and the rounding policy is "none". Choose an explicit rounding mode.',
      );
    case 'up':
      return n > 0n ? quotient + 1n : quotient;
    case 'down':
      return n > 0n ? quotient : quotient - 1n;
    case 'nearest': {
      const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
      const roundsAway = twiceRemainder >= d;
      if (!roundsAway) {
        return quotient;
      }
      return n > 0n ? quotient + 1n : quotient - 1n;
    }
  }
}

export class Decimal {
  readonly units: bigint;
  readonly scale: number;

  private constructor(units: bigint, scale: number) {
    if (!Number.isInteger(scale) || scale < 0 || scale > 9) {
      throw new DecimalError(`Unsupported scale: ${String(scale)}`);
    }
    Decimal.assertPrecision(units, scale);
    this.units = units;
    this.scale = scale;
  }

  private static assertPrecision(units: bigint, scale: number): void {
    const digits = (units < 0n ? -units : units).toString().length;
    if (digits > MAX_PRECISION) {
      throw new DecimalError(
        `Value exceeds DECIMAL(${MAX_PRECISION}, ${String(scale)}): ${units.toString()}`,
      );
    }
  }

  /**
   * Parse a decimal string. Strings are the only accepted input: a `number`
   * literal has already lost precision before this function could see it.
   *
   * More decimal places than the scale allows is an error, never a silent
   * truncation.
   */
  static parse(value: string, scale: number): Decimal {
    if (typeof value !== 'string') {
      throw new DecimalError(
        'Decimal values are constructed from strings only. A JavaScript number cannot represent them safely (DOCUMENT 27 RULE 17).',
      );
    }
    const trimmed = value.trim();
    if (!DECIMAL_PATTERN.test(trimmed)) {
      throw new DecimalError(`Not a decimal string: "${value}"`);
    }

    const negative = trimmed.startsWith('-');
    const unsigned = negative ? trimmed.slice(1) : trimmed;
    const [integerPart = '0', fractionPart = ''] = unsigned.split('.');

    if (fractionPart.length > scale) {
      throw new DecimalError(
        `"${value}" has ${String(fractionPart.length)} decimal places but the scale is ${String(scale)}. Round explicitly rather than losing digits silently.`,
      );
    }

    const padded = fractionPart.padEnd(scale, '0');
    const units = BigInt(integerPart + padded);
    return new Decimal(negative ? -units : units, scale);
  }

  /** Construct directly from minor units, e.g. 2_000_000n at scale 2 is 20000.00. */
  static fromUnits(units: bigint, scale: number): Decimal {
    return new Decimal(units, scale);
  }

  /** Construct from a whole number of major units, e.g. a count of days. */
  static fromInteger(value: bigint | number, scale: number): Decimal {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      throw new DecimalError(`Not a safe integer: ${String(value)}`);
    }
    return new Decimal(BigInt(value) * pow10(scale), scale);
  }

  static zero(scale: number): Decimal {
    return new Decimal(0n, scale);
  }

  private assertSameScale(other: Decimal, operation: string): void {
    if (other.scale !== this.scale) {
      throw new DecimalError(
        `Cannot ${operation} values of different scale (${String(this.scale)} and ${String(other.scale)}). Rescale explicitly.`,
      );
    }
  }

  add(other: Decimal): Decimal {
    this.assertSameScale(other, 'add');
    return new Decimal(this.units + other.units, this.scale);
  }

  subtract(other: Decimal): Decimal {
    this.assertSameScale(other, 'subtract');
    return new Decimal(this.units - other.units, this.scale);
  }

  negate(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  abs(): Decimal {
    return new Decimal(this.units < 0n ? -this.units : this.units, this.scale);
  }

  /** Multiply by a whole number — a day count, an incident count, a quantity of units. */
  multiplyByInteger(factor: bigint | number): Decimal {
    if (typeof factor === 'number' && !Number.isSafeInteger(factor)) {
      throw new DecimalError(`Not a safe integer factor: ${String(factor)}`);
    }
    return new Decimal(this.units * BigInt(factor), this.scale);
  }

  /**
   * Multiply by another decimal — a rate, a weight, an overtime multiplier.
   * The result is returned at this value's scale, so rounding is explicit.
   */
  multiply(other: Decimal, mode: RoundingMode = 'none'): Decimal {
    const product = this.units * other.units;
    const units = roundDivide(product, pow10(other.scale), mode);
    return new Decimal(units, this.scale);
  }

  /**
   * Divide by another decimal — monthly salary ÷ working days, for example.
   * The result is returned at this value's scale.
   */
  divide(divisor: Decimal, mode: RoundingMode = 'none'): Decimal {
    if (divisor.isZero()) {
      throw new DecimalError('Division by zero.');
    }
    const numerator = this.units * pow10(divisor.scale);
    const units = roundDivide(numerator, divisor.units, mode);
    return new Decimal(units, this.scale);
  }

  /** Divide by a whole number of days, employees, or items. */
  divideByInteger(divisor: bigint | number, mode: RoundingMode = 'none'): Decimal {
    const d = BigInt(divisor);
    if (d === 0n) {
      throw new DecimalError('Division by zero.');
    }
    return new Decimal(roundDivide(this.units, d, mode), this.scale);
  }

  /** Move to a different scale, rounding explicitly when digits are lost. */
  rescale(scale: number, mode: RoundingMode = 'none'): Decimal {
    if (scale === this.scale) {
      return this;
    }
    if (scale > this.scale) {
      return new Decimal(this.units * pow10(scale - this.scale), scale);
    }
    return new Decimal(roundDivide(this.units, pow10(this.scale - scale), mode), scale);
  }

  /**
   * Apply a company's configured rounding policy. Called once, at the end of a
   * calculation, never at intermediate steps (DOCUMENT 15 business rule 14).
   */
  applyPolicy(mode: RoundingMode, toScale = 0): Decimal {
    if (mode === 'none') {
      return this;
    }
    return this.rescale(toScale, mode).rescale(this.scale);
  }

  compare(other: Decimal): -1 | 0 | 1 {
    this.assertSameScale(other, 'compare');
    if (this.units < other.units) return -1;
    if (this.units > other.units) return 1;
    return 0;
  }

  equals(other: Decimal): boolean {
    return this.scale === other.scale && this.units === other.units;
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  isPositive(): boolean {
    return this.units > 0n;
  }

  /** Canonical string form, always carrying every digit of the scale. */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString().padStart(this.scale + 1, '0');
    const cut = digits.length - this.scale;
    const integerPart = digits.slice(0, cut);
    const fractionPart = digits.slice(cut);
    const body = this.scale === 0 ? integerPart : `${integerPart}.${fractionPart}`;
    return negative ? `-${body}` : body;
  }

  /** JSON transport is the string form — DOCUMENT 08 §1. */
  toJSON(): string {
    return this.toString();
  }

  static sum(values: readonly Decimal[], scale: number): Decimal {
    return values.reduce<Decimal>((total, value) => total.add(value), Decimal.zero(scale));
  }
}
