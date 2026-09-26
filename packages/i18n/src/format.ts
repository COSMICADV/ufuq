/**
 * Locale formatting — DOCUMENT 11 §9.
 *
 * Two rules shape this file:
 *
 *   1. A decimal string is never passed through `Number`. Grouping is applied
 *      to the string itself, so a fifteen-digit salary formats exactly
 *      (DOCUMENT 27 RULE 17).
 *   2. A timestamp is never formatted without an explicit time zone. The
 *      company timezone is always supplied by the caller; the browser's zone
 *      is never trusted (DOCUMENT 12, timezone edge case).
 */

import { toBcp47, type Locale } from './locale.js';

/** Latin digits by default in both locales; Arabic-Indic is a company setting. */
export type NumeralSystem = 'latn' | 'arab';

export interface FormatOptions {
  readonly locale: Locale;
  readonly numerals?: NumeralSystem;
}

export interface TimeFormatOptions extends FormatOptions {
  /** IANA zone, e.g. `Africa/Cairo`. Required — never defaulted to the browser. */
  readonly timeZone: string;
  readonly hour12?: boolean;
}

const ARABIC_INDIC_DIGITS = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

const SEPARATORS: Record<NumeralSystem, { group: string; decimal: string }> = {
  latn: { group: ',', decimal: '.' },
  arab: { group: '٬', decimal: '٫' },
};

/** Currency symbols by ISO code. EGP is the V1 default (DOCUMENT 01 §1). */
const CURRENCY_SYMBOLS: Record<string, { ar: string; en: string }> = {
  EGP: { ar: 'ج.م', en: 'EGP' },
};

function toNumerals(digits: string, numerals: NumeralSystem): string {
  if (numerals === 'latn') {
    return digits;
  }
  return digits.replace(/[0-9]/g, (digit) => ARABIC_INDIC_DIGITS[Number(digit)] ?? digit);
}

/** Normalise Arabic-Indic digits back to Latin — DOCUMENT 08 §5.5, DOCUMENT 20 §4. */
export function normaliseDigits(input: string): string {
  return input
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function group(integerPart: string, separator: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Format a decimal string for display.
 *
 * @param value  a decimal string such as `"20000.00"` — never a number
 */
export function formatDecimal(value: string, options: FormatOptions): string {
  const numerals = options.numerals ?? 'latn';
  const { group: groupSeparator, decimal: decimalSeparator } = SEPARATORS[numerals];

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '0', fractionPart] = unsigned.split('.');

  const grouped = group(integerPart, groupSeparator);
  const body =
    fractionPart === undefined ? grouped : `${grouped}${decimalSeparator}${fractionPart}`;

  const rendered = toNumerals(body, numerals);
  return negative ? `-${rendered}` : rendered;
}

/**
 * Format money as amount then symbol, per locale convention: `20,000 ج.م`.
 * Trailing `.00` is dropped for display; the underlying value keeps its scale.
 */
export function formatMoney(
  amount: string,
  currency: string,
  options: FormatOptions & { readonly showDecimals?: boolean },
): string {
  const showDecimals = options.showDecimals ?? false;
  const value = showDecimals ? amount : amount.replace(/\.\d+$/, '');
  const formatted = formatDecimal(value, options);
  const symbol = CURRENCY_SYMBOLS[currency]?.[options.locale] ?? currency;
  return `${formatted} ${symbol}`;
}

/** Percentages carry at most one decimal place (DOCUMENT 11 §9). */
export function formatPercent(value: string, options: FormatOptions): string {
  const [integerPart = '0', fractionPart = ''] = value.split('.');
  const firstDecimal = fractionPart.slice(0, 1);
  const trimmed =
    firstDecimal === '' || firstDecimal === '0' ? integerPart : `${integerPart}.${firstDecimal}`;
  const suffix = options.locale === 'ar' ? '٪' : '%';
  return `${formatDecimal(trimmed, options)}${suffix}`;
}

/** `DD MMM YYYY` in both locales, always in the company's time zone. */
export function formatDate(value: Date, options: TimeFormatOptions): string {
  const formatted = new Intl.DateTimeFormat(toBcp47(options.locale), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: options.timeZone,
    numberingSystem: 'latn',
  }).format(value);
  return toNumerals(formatted, options.numerals ?? 'latn');
}

/** 12-hour with ص/م in Arabic, AM/PM in English. Configurable to 24-hour. */
export function formatTime(value: Date, options: TimeFormatOptions): string {
  const formatted = new Intl.DateTimeFormat(toBcp47(options.locale), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: options.hour12 ?? true,
    timeZone: options.timeZone,
    numberingSystem: 'latn',
  }).format(value);
  return toNumerals(formatted, options.numerals ?? 'latn');
}

export function formatDateTime(value: Date, options: TimeFormatOptions): string {
  return `${formatDate(value, options)} ${formatTime(value, options)}`;
}

/** Working time renders as `8h 05m` / `٨س ٠٥د` (DOCUMENT 11 §9). */
export function formatDuration(totalMinutes: number, options: FormatOptions): string {
  if (!Number.isInteger(totalMinutes) || totalMinutes < 0) {
    throw new RangeError(
      `Duration must be a non-negative whole number of minutes: ${String(totalMinutes)}`,
    );
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const numerals = options.numerals ?? 'latn';
  const h = toNumerals(String(hours), numerals);
  const m = toNumerals(String(minutes).padStart(2, '0'), numerals);
  return options.locale === 'ar' ? `${h}س ${m}د` : `${h}h ${m}m`;
}
