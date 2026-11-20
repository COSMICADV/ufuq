import { describe, expect, it } from 'vitest';

import { amountsIn, findDate, readReceipt, suggestCategory } from './receipt-reader';

describe('readReceipt', () => {
  it('reads an English supermarket receipt', () => {
    const r = readReceipt(`Carrefour Maadi City Centre
Tax Reg: 100-200-300
Date: 18/11/2026 19:42
Milk 2L          45.00
Bread            12.50
Subtotal        201.75
VAT 14%          28.25
TOTAL EGP       230.00
Cash            250.00`);
    expect(r.merchant).toBe('Carrefour Maadi City Centre');
    expect(r.date).toBe('2026-11-18');
    expect(r.time).toBe('19:42');
    expect(r.total).toBe('230.00');
    expect(r.totalConfidence).toBe('labelled');
    expect(r.tax).toBe('28.25');
    expect(r.currency).toBe('EGP');
    expect(r.categoryKey).toBe('groceries');
  });

  it('reads an Arabic fuel receipt with Arabic-Indic digits', () => {
    const r = readReceipt(`وطنية للبترول
محطة الشيخ زايد
التاريخ ٢٠/١١/٢٠٢٦
بنزين ٩٢  ٣٠ لتر
الإجمالي  ٤٥٠٫٠٠ ج.م`);
    expect(r.merchant).toBe('وطنية للبترول');
    expect(r.date).toBe('2026-11-20');
    expect(r.total).toBe('450.00');
    expect(r.currency).toBe('EGP');
    expect(r.categoryKey).toBe('fuel');
  });

  it('takes the total from the next line, and the last labelled total', () => {
    const r = readReceipt(`Zooba
Total
185.50
Grand Total
212.00`);
    expect(r.total).toBe('212.00');
    expect(r.categoryKey).toBe('food');
  });

  it('only guesses the largest amount when no total is labelled', () => {
    const r = readReceipt(`El Ezaby Pharmacy
Panadol 1   48.00
Vitamin C   92.50`);
    expect(r.total).toBe('92.50');
    expect(r.totalConfidence).toBe('guess');
    expect(r.categoryKey).toBe('health');
  });

  it('returns nothing it cannot read', () => {
    const r = readReceipt('~~~ ### ~~~');
    expect(r).toMatchObject({ merchant: null, date: null, total: null, tax: null, currency: null, categoryKey: null });
  });
});

describe('pieces', () => {
  it('reads thousands separators and comma decimals', () => {
    expect(amountsIn('Total 1,250.75')).toContain('1250.75');
    expect(amountsIn('المجموع ١٬٢٥٠٫٥')).toContain('1250.50');
  });
  it('rejects impossible dates and reads ISO dates', () => {
    expect(findDate('31/02/2026')).toBeNull();
    expect(findDate('2026-11-05')).toBe('2026-11-05');
    expect(findDate('05-11-26')).toBe('2026-11-05');
  });
  it('suggests from the merchant first', () => {
    expect(suggestCategory('Uber', 'total 50')).toBe('transport');
    expect(suggestCategory('Netflix', '')).toBe('subscriptions');
    expect(suggestCategory(null, 'nothing known')).toBeNull();
  });
});
