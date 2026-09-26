import { describe, expect, it } from 'vitest';

import { localeFromPath, pathInLocale, redirectTarget } from './locale-route';

describe('localeFromPath', () => {
  it('reads the locale from the first segment', () => {
    expect(localeFromPath('/ar')).toBe('ar');
    expect(localeFromPath('/en/anything')).toBe('en');
  });

  it('returns null when the path carries no locale', () => {
    expect(localeFromPath('/')).toBeNull();
    expect(localeFromPath('/fr')).toBeNull();
    expect(localeFromPath('/admin')).toBeNull();
  });
});

describe('pathInLocale', () => {
  it('swaps the locale and keeps the rest of the path', () => {
    expect(pathInLocale('/ar', 'en')).toBe('/en');
    expect(pathInLocale('/en/admin/employees', 'ar')).toBe('/ar/admin/employees');
  });

  it('adds the locale to an unprefixed path', () => {
    expect(pathInLocale('/', 'ar')).toBe('/ar');
    expect(pathInLocale('/admin', 'en')).toBe('/en/admin');
  });

  it('round-trips both directions', () => {
    expect(pathInLocale(pathInLocale('/ar/admin', 'en'), 'ar')).toBe('/ar/admin');
  });
});

describe('redirectTarget', () => {
  it('honours a supported Accept-Language', () => {
    expect(redirectTarget('/', 'en-GB,en;q=0.9')).toBe('/en');
    expect(redirectTarget('/', 'ar-EG,ar;q=0.9')).toBe('/ar');
  });

  it('falls back to Arabic for anything else', () => {
    expect(redirectTarget('/', 'fr-FR,fr;q=0.9')).toBe('/ar');
    expect(redirectTarget('/', null)).toBe('/ar');
  });
});
