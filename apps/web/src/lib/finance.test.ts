import { describe, expect, it } from 'vitest';

import { categoryLabel, readAmount, share } from './finance';

describe('readAmount', () => {
  it('reads plain, Arabic-Indic and comma-decimal amounts', () => {
    expect(readAmount('250')).toBe('250');
    expect(readAmount(' 12.5 ')).toBe('12.5');
    expect(readAmount('١٢٣٫٤٥')).toBe('123.45');
    expect(readAmount('99,90')).toBe('99.90');
    expect(readAmount('1,250.75')).toBe('1250.75');
  });
  it('rejects zero, negatives, three decimals and text', () => {
    expect(readAmount('0')).toBeNull();
    expect(readAmount('0.00')).toBeNull();
    expect(readAmount('-5')).toBeNull();
    expect(readAmount('1.234')).toBeNull();
    expect(readAmount('abc')).toBeNull();
    expect(readAmount('')).toBeNull();
  });
});

describe('categoryLabel', () => {
  const t = (key: string): string => `[${key}]`;
  it('prefers the person’s own name, then the default label', () => {
    expect(categoryLabel({ key: 'fuel', name: 'Car fuel' }, t)).toBe('Car fuel');
    expect(categoryLabel({ key: 'fuel', name: null }, t)).toBe('[finance.cat.fuel]');
    expect(categoryLabel({ key: null, name: null }, t)).toBe('[finance.uncategorized]');
  });
});

describe('share', () => {
  it('is a bounded percentage', () => {
    expect(share('25', '100')).toBe(25);
    expect(share('5', '0')).toBe(0);
    expect(share('150', '100')).toBe(100);
  });
});
