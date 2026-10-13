/**
 * The inventory client rules — DOCUMENT 17, DOCUMENT 26 (web): forms
 * validated before they are sent and kept as typed, no quantity on any
 * product request, movement semantics that match the server's, and every
 * label the screens use present in both languages.
 */

import { createTranslator } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api-client';
import {
  EMPTY_MOVEMENT_FORM,
  EMPTY_PRODUCT_FORM,
  EMPTY_SUPPLIER_FORM,
  MOVEMENT_FORM_TYPES,
  PRODUCT_STATUSES,
  STOCK_STATUSES,
  SUPPLIER_STATUSES,
  costAllowed,
  duplicateSku,
  formFromProduct,
  formFromSupplier,
  inventoryPath,
  isNegative,
  movementBody,
  movementIsOutbound,
  normaliseAmount,
  normaliseMinStock,
  productBody,
  productPath,
  reasonRequired,
  stockFigures,
  stockTone,
  supplierBody,
  validateMovementForm,
  validateProductForm,
  validateSupplierForm,
} from './inventory';
import type { Product, Supplier } from './inventory';

const product: Product = {
  id: 'p1',
  name_ar: 'قماش',
  name_en: 'Fabric',
  sku: 'FAB-1',
  unit: 'metre',
  category: { id: 'c1', name_ar: 'أقمشة', name_en: 'Fabrics' },
  supplier: { id: 's1', name: 'Delta' },
  min_stock: '10.000',
  cost_price: '35.00',
  selling_price: '60.00',
  image_attachment_id: null,
  description: null,
  status: 'active',
  total_quantity: '135.000',
  stock_value: '5087.25',
  stock_status: 'in_stock',
  created_at: '2026-10-13T08:00:00.000Z',
  updated_at: '2026-10-13T08:00:00.000Z',
};

const error = (fields: Record<string, string[]>, code = 'VALIDATION_FAILED') =>
  new ApiError(422, { code, message_ar: 'x', message_en: 'x', fields });

describe('paths and display', () => {
  it('builds the six inventory routes', () => {
    expect(inventoryPath('ar')).toBe('/ar/admin/inventory');
    expect(inventoryPath('en', 'new')).toBe('/en/admin/inventory/new');
    expect(inventoryPath('en', 'movements')).toBe('/en/admin/inventory/movements');
    expect(inventoryPath('ar', 'suppliers')).toBe('/ar/admin/inventory/suppliers');
    expect(productPath('en', 'p1')).toBe('/en/admin/inventory/p1');
    expect(productPath('en', 'p1', true)).toBe('/en/admin/inventory/p1/movements');
  });

  it('stock status tones, and negative balances recognised without arithmetic', () => {
    expect(STOCK_STATUSES.map(stockTone)).toEqual(['success', 'warning', 'danger']);
    expect(isNegative('-3.000')).toBe(true);
    expect(isNegative('-0.000')).toBe(false);
    expect(isNegative('3.000')).toBe(false);
  });
});

describe('decimal shapes', () => {
  it('amounts: zero or more, at most two decimals, Arabic-Indic digits accepted', () => {
    expect(normaliseAmount('٣٥')).toBe('35');
    expect(normaliseAmount('0')).toBe('0');
    expect(normaliseAmount('12.50')).toBe('12.50');
    for (const bad of ['-1', '1.001', 'abc', '']) expect(normaliseAmount(bad), bad).toBeNull();
  });

  it('minimum stock: zero or more, at most three decimals', () => {
    expect(normaliseMinStock('0')).toBe('0');
    expect(normaliseMinStock('2.125')).toBe('2.125');
    for (const bad of ['-1', '1.0001', '']) expect(normaliseMinStock(bad), bad).toBeNull();
  });
});

describe('the product form (DOCUMENT 17 "Validation")', () => {
  const valid = { ...EMPTY_PRODUCT_FORM, name_ar: 'م', name_en: 'P', sku: 'P-1', unit: 'piece' };

  it('requires names, SKU (≤ 50) and unit; prices and minimum stock ≥ 0', () => {
    expect(validateProductForm(EMPTY_PRODUCT_FORM, true)).toEqual({
      name_ar: 'validation.required',
      name_en: 'validation.required',
      sku: 'validation.required',
      unit: 'validation.required',
    });
    expect(validateProductForm({ ...valid, sku: 'S'.repeat(51) }, true)).toEqual({
      sku: 'validation.too_long',
    });
    expect(
      validateProductForm(
        { ...valid, min_stock: '-1', cost_price: '1.001', selling_price: '-5' },
        true,
      ),
    ).toEqual({
      min_stock: 'validation.non_negative_quantity',
      cost_price: 'validation.amount',
      selling_price: 'validation.amount',
    });
  });

  it('initial stock is optional; once started, it needs a location and a positive quantity', () => {
    expect(validateProductForm(valid, true)).toEqual({});
    expect(validateProductForm({ ...valid, initial_quantity: '5' }, true)).toEqual({
      initial_warehouse_id: 'validation.required',
    });
    expect(
      validateProductForm({ ...valid, initial_warehouse_id: 'w1', initial_quantity: '0' }, true),
    ).toEqual({
      initial_quantity: 'validation.quantity',
    });
    // Editing never looks at initial stock.
    expect(validateProductForm({ ...valid, initial_quantity: 'junk' }, false)).toEqual({});
  });

  it('the create body carries the initial stock as a nested request, never a quantity field', () => {
    const body = productBody({
      ...valid,
      initial_warehouse_id: 'w1',
      initial_quantity: '١٠٠',
      initial_unit_cost: '35',
    });
    expect(body).toEqual({
      name_ar: 'م',
      name_en: 'P',
      sku: 'P-1',
      unit: 'piece',
      min_stock: '0',
      cost_price: '0.00',
      selling_price: '0.00',
      initial_stock: { warehouse_id: 'w1', quantity: '100', unit_cost: '35' },
    });
    expect(Object.keys(body)).not.toContain('quantity');
  });

  it('an edit sends only what changed, and clearing a reference sends null', () => {
    const form = formFromProduct(product);
    expect(productBody(form, product)).toEqual({});
    expect(productBody({ ...form, cost_price: '50.00', category_id: '' }, product)).toEqual({
      cost_price: '50.00',
      category_id: null,
    });
    expect(Object.keys(productBody({ ...form, name_en: 'X' }, product))).toEqual(['name_en']);
  });

  it('a duplicate SKU names the product that has it (rule 10)', () => {
    expect(
      duplicateSku(
        error({
          sku: ['already_taken'],
          existing_product_id: ['p1'],
          existing_product_name_ar: ['قماش'],
          existing_product_name_en: ['Fabric'],
        }),
      ),
    ).toEqual({ id: 'p1', name_ar: 'قماش', name_en: 'Fabric' });
    expect(duplicateSku(error({ sku: ['invalid'] }))).toBeNull();
  });
});

describe('the movement form (FLOW 18)', () => {
  const base = { ...EMPTY_MOVEMENT_FORM, warehouse_id: 'w1', quantity: '5' };

  it('direction follows the type; an adjustment asks; cost only on inbound', () => {
    for (const type of ['sale', 'damage', 'manual_removal'] as const) {
      expect(movementIsOutbound({ ...base, type }), type).toBe(true);
      expect(costAllowed({ ...base, type }), type).toBe(false);
    }
    for (const type of ['purchase', 'return', 'manual_addition'] as const) {
      expect(movementIsOutbound({ ...base, type }), type).toBe(false);
      expect(costAllowed({ ...base, type }), type).toBe(true);
    }
    expect(movementIsOutbound({ ...base, type: 'adjustment', direction: 'decrease' })).toBe(true);
    expect(costAllowed({ ...base, type: 'adjustment', direction: 'increase' })).toBe(true);
    expect(MOVEMENT_FORM_TYPES).not.toContain('transfer_in');
    expect(MOVEMENT_FORM_TYPES).not.toContain('transfer_out');
  });

  it('reason on adjustment and damage; cost on a purchase; a positive quantity', () => {
    expect(reasonRequired('adjustment')).toBe(true);
    expect(reasonRequired('damage')).toBe(true);
    expect(reasonRequired('sale')).toBe(false);
    expect(validateMovementForm({ ...base, type: 'damage' })).toEqual({
      reason: 'validation.required',
    });
    expect(validateMovementForm({ ...base, type: 'purchase' })).toEqual({
      unit_cost: 'validation.required',
    });
    expect(validateMovementForm({ ...base, type: 'sale', quantity: '0' })).toEqual({
      quantity: 'validation.quantity',
    });
    expect(validateMovementForm(EMPTY_MOVEMENT_FORM)).toEqual({
      warehouse_id: 'validation.required',
      type: 'validation.required',
      quantity: 'validation.required',
    });
  });

  it('the body: the server decides the sign, except an adjustment, which is signed', () => {
    expect(movementBody({ ...base, type: 'sale', unit_cost: '9' }, 'p1')).toEqual({
      product_id: 'p1',
      warehouse_id: 'w1',
      type: 'sale',
      quantity: '5',
    });
    expect(
      movementBody({ ...base, type: 'adjustment', direction: 'decrease', reason: ' Count ' }, 'p1'),
    ).toEqual({
      product_id: 'p1',
      warehouse_id: 'w1',
      type: 'adjustment',
      quantity: '-5',
      reason: 'Count',
    });
    expect(movementBody({ ...base, type: 'purchase', unit_cost: '٤١' }, 'p1', true)).toMatchObject({
      quantity: '5',
      unit_cost: '41',
      acknowledge_negative_stock: true,
    });
  });

  it('reads the figures of a negative-stock warning', () => {
    expect(
      stockFigures(
        error(
          { available: ['5.000'], requested: ['8.000'], resulting_balance: ['-3.000'] },
          'STOCK_NEGATIVE_WARNING',
        ),
      ),
    ).toEqual({ available: '5.000', requested: '8.000', resulting: '-3.000' });
    expect(stockFigures(error({}))).toBeNull();
  });
});

describe('the supplier form', () => {
  const supplier: Supplier = {
    id: 's1',
    name: 'Delta',
    contact_person: null,
    phone: null,
    email: 'sales@delta.test',
    address: null,
    status: 'active',
    product_count: 1,
  };

  it('requires a name; email and phone, when given, have a valid shape', () => {
    expect(validateSupplierForm(EMPTY_SUPPLIER_FORM)).toEqual({ name: 'validation.required' });
    expect(
      validateSupplierForm({ ...EMPTY_SUPPLIER_FORM, name: 'D', email: 'nope', phone: 'abc' }),
    ).toEqual({
      email: 'validation.invalid',
      phone: 'validation.invalid',
    });
    expect(
      validateSupplierForm({ ...EMPTY_SUPPLIER_FORM, name: 'D', phone: '+٢٠ ١٠٠ ١٢٣' }),
    ).toEqual({});
  });

  it('create omits blanks; edit sends only what changed, null to clear', () => {
    expect(supplierBody({ ...EMPTY_SUPPLIER_FORM, name: ' Nile ' })).toEqual({ name: 'Nile' });
    const form = formFromSupplier(supplier);
    expect(supplierBody(form, supplier)).toEqual({});
    expect(supplierBody({ ...form, email: '', phone: '010' }, supplier)).toEqual({
      email: null,
      phone: '010',
    });
  });
});

describe('every inventory label exists in Arabic and English', () => {
  const keys = [
    'inventory.title',
    'inventory.description',
    'inventory.record_movement',
    'inventory.negative_title',
    'inventory.negative_body',
    'inventory.sku_taken',
    'inventory.reconcile_row',
    'inventory.deactivate_body',
    'settings.allow_negative_stock',
    'settings.allow_negative_stock_toggle',
    'validation.amount',
    'validation.non_negative_quantity',
    'validation.use_transfer',
    'validation.not_allowed',
    'error.stock_negative_warning',
    'error.idempotency_key_required',
    'warehouse.kpi_total_products',
    'warehouse.low_stock_table',
    ...STOCK_STATUSES.map((s) => `inventory.stock_status.${s}`),
    ...PRODUCT_STATUSES.map((s) => `inventory.status.${s}`),
    ...SUPPLIER_STATUSES.map((s) => `inventory.supplier_status.${s}`),
    ...MOVEMENT_FORM_TYPES.map((type) => `warehouse.movement.${type}`),
  ];
  for (const locale of ['ar', 'en'] as const) {
    it(locale, () => {
      const t = createTranslator(locale);
      const vars = {
        name: '',
        available: '',
        requested: '',
        resulting: '',
        quantity: '',
        cached: '',
        ledger: '',
        cached_cost: '',
        ledger_cost: '',
        count: '',
      };
      for (const key of keys) expect(() => t(key, vars), key).not.toThrow();
    });
  }
});
