import { describe, expect, it } from 'vitest';

import { contrastRatio, displayName, isHexColor, svgLooksUnsafe, thermalSuitable } from './brand';

describe('brand helpers', () => {
  it('names the business in the reader’s language, then the other, then the company', () => {
    const base = { company_name: 'Co', name_ar: 'كافيه', name_en: 'Cafe' };
    expect(displayName(base, 'ar')).toBe('كافيه');
    expect(displayName(base, 'en')).toBe('Cafe');
    expect(displayName({ ...base, name_en: null }, 'fr')).toBe('كافيه');
    expect(displayName({ company_name: 'Co', name_ar: ' ', name_en: null }, 'ar')).toBe('Co');
  });
  it('judges thermal printing by ink coverage', () => {
    expect(thermalSuitable(0.2)).toBe(true);
    expect(thermalSuitable(0.005)).toBe(false);
    expect(thermalSuitable(0.8)).toBe(false);
  });
  it('checks colours and contrast', () => {
    expect(isHexColor('#1E7AFF')).toBe(true);
    expect(isHexColor('blue')).toBe(false);
    expect(contrastRatio('#0B1E4B', '#FFFFFF')).toBeGreaterThan(10);
  });
  it('flags SVGs the API would refuse', () => {
    expect(svgLooksUnsafe('<svg viewBox="0 0 1 1"><rect/></svg>')).toBe(false);
    expect(svgLooksUnsafe('<svg><script>x</script></svg>')).toBe(true);
    expect(svgLooksUnsafe('<svg><image href="https://x.test/a.png"/></svg>')).toBe(true);
    expect(svgLooksUnsafe('not svg')).toBe(true);
  });
});
