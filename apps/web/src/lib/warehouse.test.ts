/**
 * The warehouse client rules — DOCUMENT 17, DOCUMENT 26 (web): forms
 * validated before they are sent, quantities compared exactly, nothing that
 * sets a quantity, and every label the screens use present in both languages.
 */

import { createTranslator } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import { ApiError, issueKeyFor } from './api-client';
import {
  EMPTY_LINE,
  EMPTY_WAREHOUSE_FORM,
  MOVEMENT_TYPES,
  WAREHOUSE_TYPES,
  emptyTransferForm,
  formFromWarehouse,
  insufficientDetail,
  localName,
  movementTone,
  normaliseQuantity,
  quantityLabel,
  transferBody,
  validateTransferForm,
  validateWarehouseForm,
  warehouseBody,
  warehousePath,
  withinAvailable,
} from './warehouse';
import type { Warehouse } from './warehouse';

const warehouse: Warehouse = {
  id: 'w1',
  name_ar: 'المخزن الرئيسي',
  name_en: 'Main warehouse',
  type: 'main',
  address: 'Cairo',
  is_active: true,
  created_at: '2026-10-13T08:00:00.000Z',
  product_count: 2,
  total_quantity: '130.500',
  stock_value: '4342.50',
};

describe('paths and display', () => {
  it('builds the four warehouse routes', () => {
    expect(warehousePath('ar')).toBe('/ar/admin/warehouse');
    expect(warehousePath('en', 'locations')).toBe('/en/admin/warehouse/locations');
    expect(warehousePath('en', 'locations', 'w1')).toBe('/en/admin/warehouse/locations/w1');
    expect(warehousePath('ar', 'transfers')).toBe('/ar/admin/warehouse/transfers');
  });

  it('names a location in the reader’s language', () => {
    expect(localName(warehouse, 'ar')).toBe('المخزن الرئيسي');
    expect(localName(warehouse, 'en')).toBe('Main warehouse');
    expect(localName({ name_ar: ' ', name_en: 'Online' }, 'ar')).toBe('Online');
  });

  it('drops trailing zeros from a quantity and never rounds it', () => {
    expect(quantityLabel('120.500')).toBe('120.5');
    expect(quantityLabel('10.000')).toBe('10');
    expect(quantityLabel('0.001')).toBe('0.001');
    expect(quantityLabel('-20.250')).toBe('-20.25');
    expect(quantityLabel('0.000')).toBe('0');
    expect(quantityLabel('7')).toBe('7');
  });

  it('gives every movement type a tone', () => {
    for (const type of MOVEMENT_TYPES) expect(movementTone(type)).toBeTruthy();
    expect(movementTone('transfer_out')).toBe('info');
    expect(movementTone('damage')).toBe('danger');
  });
});

describe('quantities are compared exactly', () => {
  it('accepts a positive DECIMAL(15,3), Arabic-Indic digits included', () => {
    expect(normaliseQuantity('12.5')).toBe('12.5');
    expect(normaliseQuantity(' ١٢٫٥ '.replace('٫', '.'))).toBe('12.5');
    for (const bad of ['0', '0.000', '-1', '1.0001', '1e3', 'abc', '', '1,5']) {
      expect(normaliseQuantity(bad), bad).toBeNull();
    }
  });

  it('within available: equal fits, a thousandth more does not — no floating point', () => {
    expect(withinAvailable('120.5', '120.500')).toBe(true);
    expect(withinAvailable('120.501', '120.500')).toBe(false);
    // 0.1 + 0.2 style traps do not apply: these are scaled integers.
    expect(withinAvailable('0.3', '0.300')).toBe(true);
    expect(withinAvailable('999999999999.999', '999999999999.999')).toBe(true);
  });
});

describe('the location form', () => {
  it('requires both names and a type', () => {
    expect(validateWarehouseForm(EMPTY_WAREHOUSE_FORM)).toEqual({
      name_ar: 'validation.required',
      name_en: 'validation.required',
      type: 'validation.required',
    });
    expect(
      validateWarehouseForm({ ...formFromWarehouse(warehouse), name_en: 'x'.repeat(201) }),
    ).toEqual({
      name_en: 'validation.too_long',
    });
  });

  it('creates with what was typed; edits send only what changed — never a quantity', () => {
    expect(
      warehouseBody({ name_ar: ' م ', name_en: 'Online', type: 'online', address: '' }),
    ).toEqual({
      name_ar: 'م',
      name_en: 'Online',
      type: 'online',
    });
    expect(warehouseBody({ ...formFromWarehouse(warehouse), address: '' }, warehouse)).toEqual({
      address: null,
    });
    expect(warehouseBody(formFromWarehouse(warehouse), warehouse)).toEqual({});
    expect(
      Object.keys(warehouseBody({ ...formFromWarehouse(warehouse), name_en: 'X' }, warehouse)),
    ).not.toContain('quantity');
  });
});

describe('the transfer form (DOCUMENT 17 "Validation")', () => {
  const available = new Map([
    ['p1', '100.250'],
    ['p2', '6.000'],
  ]);
  const ok = {
    source_warehouse_id: 'a',
    destination_warehouse_id: 'b',
    lines: [
      { product_id: 'p1', quantity: '20.25' },
      { product_id: 'p2', quantity: '6' },
    ],
    note: '',
  };

  it('a valid transfer has no issues and sends normalised quantities', () => {
    expect(validateTransferForm(ok, available)).toEqual({});
    expect(transferBody({ ...ok, note: ' Restock ' })).toEqual({
      source_warehouse_id: 'a',
      destination_warehouse_id: 'b',
      lines: [
        { product_id: 'p1', quantity: '20.25' },
        { product_id: 'p2', quantity: '6' },
      ],
      note: 'Restock',
    });
  });

  it('refuses the same location, a repeated product, a bad or excessive quantity', () => {
    expect(validateTransferForm({ ...ok, destination_warehouse_id: 'a' }, available)).toEqual({
      destination_warehouse_id: 'validation.same_location',
    });
    expect(
      validateTransferForm(
        {
          ...ok,
          lines: [
            { product_id: 'p1', quantity: '1' },
            { product_id: 'p1', quantity: '2' },
          ],
        },
        available,
      ),
    ).toEqual({ 'lines.1.product_id': 'validation.duplicate_product' });
    expect(
      validateTransferForm({ ...ok, lines: [{ product_id: 'p1', quantity: '0' }] }, available),
    ).toEqual({
      'lines.0.quantity': 'validation.quantity',
    });
    expect(
      validateTransferForm({ ...ok, lines: [{ product_id: 'p2', quantity: '6.001' }] }, available),
    ).toEqual({
      'lines.0.quantity': 'validation.exceeds_available',
    });
  });

  it('an empty form names every required field', () => {
    expect(validateTransferForm(emptyTransferForm(), available)).toEqual({
      source_warehouse_id: 'validation.required',
      destination_warehouse_id: 'validation.required',
      'lines.0.product_id': 'validation.required',
      'lines.0.quantity': 'validation.required',
    });
    expect(emptyTransferForm('a').lines).toEqual([EMPTY_LINE]);
  });
});

describe('the server’s refusals', () => {
  it('reads what the source held from STOCK_INSUFFICIENT', () => {
    const error = new ApiError(422, {
      code: 'STOCK_INSUFFICIENT',
      message_ar: 'x',
      message_en: 'x',
      fields: {
        product_id: ['p1'],
        warehouse_id: ['a'],
        available: ['100.250'],
        requested: ['200.000'],
      },
    });
    expect(insufficientDetail(error)).toEqual({
      productId: 'p1',
      available: '100.250',
      requested: '200.000',
    });
    expect(
      insufficientDetail(
        new ApiError(422, {
          code: 'VALIDATION_FAILED',
          message_ar: 'x',
          message_en: 'x',
          fields: {},
        }),
      ),
    ).toBeNull();
  });

  it('maps the transfer validation issues to translated messages', () => {
    const error = new ApiError(422, {
      code: 'VALIDATION_FAILED',
      message_ar: 'x',
      message_en: 'x',
      fields: {
        destination_warehouse_id: ['same_location'],
        'lines.1.product_id': ['duplicate_product'],
      },
    });
    expect(issueKeyFor(error, 'destination_warehouse_id')).toBe('validation.same_location');
    expect(issueKeyFor(error, 'lines.1.product_id')).toBe('validation.duplicate_product');
  });
});

describe('every warehouse label exists in Arabic and English', () => {
  const keys = [
    'warehouse.title',
    'warehouse.description',
    'warehouse.nav_dashboard',
    'warehouse.nav_locations',
    'warehouse.nav_transfers',
    'warehouse.kpi_locations',
    'warehouse.kpi_products_in_stock',
    'warehouse.kpi_units',
    'warehouse.kpi_value',
    'warehouse.deferred_title',
    'warehouse.deferred',
    'warehouse.new_location',
    'warehouse.edit_location',
    'warehouse.deactivate',
    'warehouse.activate',
    'warehouse.new_transfer',
    'warehouse.transfer_title',
    'warehouse.no_products_note',
    'warehouse.transfer_done',
    'warehouse.insufficient',
    'validation.same_location',
    'validation.duplicate_product',
    'validation.quantity',
    'validation.exceeds_available',
    'error.warehouse_has_stock',
    'error.warehouse_inactive',
    'error.stock_insufficient',
    ...WAREHOUSE_TYPES.map((type) => `warehouse.type.${type}`),
    ...MOVEMENT_TYPES.map((type) => `warehouse.movement.${type}`),
  ];
  for (const locale of ['ar', 'en'] as const) {
    it(locale, () => {
      const t = createTranslator(locale);
      for (const key of keys)
        expect(() => t(key, { detail: '', available: '', requested: '' }), key).not.toThrow();
    });
  }
});
