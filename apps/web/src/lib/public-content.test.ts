import { describe, it, expect } from 'vitest';
import { LOCALES } from '@ufuq/i18n';
import { PUBLIC_PAGES, publicCopy, publicPath, features } from './public-content';
describe('Phase 16 routes and content', () => {
  it('has nine pages with unique bilingual titles and descriptions', () => {
    expect(PUBLIC_PAGES).toHaveLength(9);
    for (const locale of LOCALES) {
      expect(publicCopy[locale].titles).toHaveLength(9);
      expect(new Set(publicCopy[locale].titles).size).toBe(9);
      expect(new Set(publicCopy[locale].descriptions).size).toBe(9);
      expect(publicCopy[locale].nav).toHaveLength(9);
    }
  });
  it('prefixes every public URL with its language (the bare root is the language choice)', () => {
    for (const locale of LOCALES) {
      expect(publicPath(locale, 'home')).toBe(`/${locale}`);
      for (const page of PUBLIC_PAGES.filter((p) => p !== 'home')) {
        expect(publicPath(locale, page)).toBe(`/${locale}/${page}`);
      }
    }
  });
  it('covers every real V1 module in both languages', () => {
    expect(features.ar).toHaveLength(11);
    expect(features.en).toHaveLength(11);
    for (const locale of LOCALES) expect(features[locale]).toHaveLength(11);
  });
  it('marks individuals as unavailable and avoids unapproved pricing', () => {
    expect(publicCopy.en.descriptions[4]).toContain('not available');
    expect(publicCopy.ar.titles[4]).toContain('قريباً');
    expect(publicCopy.en.pricingNote).toContain('No approved prices');
  });
});
