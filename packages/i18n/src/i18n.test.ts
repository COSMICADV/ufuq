import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDecimal,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTime,
  normaliseDigits,
} from './format.js';
import {
  DEFAULT_LOCALE,
  documentAttributes,
  getDirection,
  isLocale,
  isRtl,
  resolveLocale,
} from './locale.js';
import {
  CATALOGUE_LOCALES,
  createTranslator,
  getMessages,
  messageKeys,
  MissingMessageError,
  NAMESPACES,
} from './messages.js';

const CAIRO = 'Africa/Cairo';

describe('locale and direction', () => {
  it('defaults to Arabic (DOCUMENT 01 NFR-01)', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
    expect(getDirection(DEFAULT_LOCALE)).toBe('rtl');
  });

  it('maps each locale to one direction', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(getDirection('en')).toBe('ltr');
  });

  it('produces the document root attributes', () => {
    expect(documentAttributes('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(documentAttributes('en')).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('resolves Accept-Language, falling back to Arabic', () => {
    expect(resolveLocale('en-GB,en;q=0.9')).toBe('en');
    expect(resolveLocale('ar-EG,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(resolveLocale('fr-FR')).toBe('ar');
    expect(resolveLocale(null)).toBe('ar');
    expect(resolveLocale('')).toBe('ar');
  });

  it('recognises only the supported locales', () => {
    expect(isLocale('ar')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });
});

describe('message catalogue', () => {
  it('has identical keys in every locale (RULE 25)', () => {
    for (const namespace of NAMESPACES) {
      const [first, ...rest] = CATALOGUE_LOCALES;
      const reference = messageKeys(getMessages(first, namespace)).sort();
      for (const locale of rest) {
        expect(messageKeys(getMessages(locale, namespace)).sort()).toEqual(reference);
      }
    }
  });

  it('translates in both directions', () => {
    expect(createTranslator('ar')('app.name')).toBe('أُفق');
    expect(createTranslator('en')('app.name')).toBe('Ufuq');
  });

  it('throws on a missing key rather than rendering one', () => {
    expect(() => createTranslator('ar')('app.does_not_exist')).toThrow(MissingMessageError);
  });
});

describe('number and money formatting', () => {
  it('groups a decimal string without converting it to a number', () => {
    expect(formatDecimal('1234567.89', { locale: 'en' })).toBe('1,234,567.89');
    expect(formatDecimal('-1000.50', { locale: 'en' })).toBe('-1,000.50');
  });

  it('keeps full precision on a value a float would corrupt', () => {
    expect(formatDecimal('999999999999.99', { locale: 'en' })).toBe('999,999,999,999.99');
  });

  it('renders Arabic-Indic numerals when the company selects them', () => {
    expect(formatDecimal('20000.00', { locale: 'ar', numerals: 'arab' })).toBe('٢٠٬٠٠٠٫٠٠');
  });

  it('renders money as amount then symbol (DOCUMENT 11 §9)', () => {
    expect(formatMoney('20000.00', 'EGP', { locale: 'ar' })).toBe('20,000 ج.م');
    expect(formatMoney('20000.00', 'EGP', { locale: 'en' })).toBe('20,000 EGP');
    expect(formatMoney('19500.75', 'EGP', { locale: 'ar', showDecimals: true })).toBe(
      '19,500.75 ج.م',
    );
  });

  it('caps percentages at one decimal place', () => {
    expect(formatPercent('93.333', { locale: 'en' })).toBe('93.3%');
    expect(formatPercent('75.00', { locale: 'ar' })).toBe('75٪');
  });

  it('normalises Arabic-Indic digits back to Latin for input', () => {
    expect(normaliseDigits('٢٠٠٠٠')).toBe('20000');
    expect(normaliseDigits('۱۲۳')).toBe('123');
  });
});

describe('date, time and duration formatting', () => {
  const summer = new Date('2026-09-07T06:57:00.000Z'); // Cairo is UTC+3 (DST)
  const winter = new Date('2026-01-07T06:57:00.000Z'); // Cairo is UTC+2

  it('formats in the company time zone, never the browser zone', () => {
    expect(formatTime(summer, { locale: 'en', timeZone: CAIRO })).toBe('09:57 am');
    expect(formatTime(summer, { locale: 'en', timeZone: 'UTC' })).toBe('06:57 am');
  });

  it('follows the zone across a DST change (Egypt observes DST)', () => {
    expect(formatTime(summer, { locale: 'en', timeZone: CAIRO, hour12: false })).toBe('09:57');
    expect(formatTime(winter, { locale: 'en', timeZone: CAIRO, hour12: false })).toBe('08:57');
  });

  it('renders ص and م in Arabic', () => {
    expect(formatTime(summer, { locale: 'ar', timeZone: CAIRO })).toBe('09:57 ص');
  });

  it('formats dates as DD MMM YYYY', () => {
    expect(formatDate(summer, { locale: 'en', timeZone: CAIRO })).toBe('07 Sept 2026');
    expect(formatDate(summer, { locale: 'ar', timeZone: CAIRO })).toBe('07 سبتمبر 2026');
  });

  it('formats working time as hours and minutes', () => {
    expect(formatDuration(485, { locale: 'en' })).toBe('8h 05m');
    expect(formatDuration(485, { locale: 'ar', numerals: 'arab' })).toBe('٨س ٠٥د');
    expect(formatDuration(0, { locale: 'en' })).toBe('0h 00m');
  });

  it('rejects a nonsensical duration', () => {
    expect(() => formatDuration(-5, { locale: 'en' })).toThrow(RangeError);
  });
});
