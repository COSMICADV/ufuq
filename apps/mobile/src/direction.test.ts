import { LOCALES } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import { directionStyle, nextLocale } from './direction';

describe('directionStyle', () => {
  it('lays Arabic out right to left', () => {
    expect(directionStyle('ar')).toEqual({ direction: 'rtl', writingDirection: 'rtl' });
  });

  it('lays English out left to right', () => {
    expect(directionStyle('en')).toEqual({ direction: 'ltr', writingDirection: 'ltr' });
  });

  it('never leaves direction unset for a supported locale', () => {
    for (const locale of LOCALES) {
      expect(['rtl', 'ltr']).toContain(directionStyle(locale).direction);
    }
  });
});

describe('nextLocale', () => {
  it('cycles through every locale and returns to the first', () => {
    expect(nextLocale('ar', LOCALES)).toBe('en');
    expect(nextLocale(nextLocale('ar', LOCALES), LOCALES)).toBe('ar');
  });
});
