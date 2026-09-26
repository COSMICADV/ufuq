/**
 * The audit log screen's pure rules — DOCUMENT 21 "UI", DOCUMENT 11 §6.
 */

import { createTranslator, LOCALES } from '@ufuq/i18n';
import { describe, expect, it } from 'vitest';

import {
  actionKey,
  AUDIT_ACTIONS,
  auditLogPath,
  AUDIT_ENTITY_TYPES,
  auditQuery,
  EMPTY_FILTERS,
  entityHistoryPath,
  entityTypeKey,
  fieldChanges,
  filtersFromParams,
  hasFilters,
  shortId,
  withFilters,
} from './audit';

describe('filters in the URL — DOCUMENT 11 §6', () => {
  it('reads every documented filter, and treats a missing one as unfiltered', () => {
    const filters = filtersFromParams(
      new URLSearchParams('action=login.success&from=2026-03-01&page=3'),
    );
    expect(filters).toEqual({ ...EMPTY_FILTERS, action: 'login.success', from: '2026-03-01' });
    expect(hasFilters(filters)).toBe(true);
    expect(hasFilters(filtersFromParams(new URLSearchParams('page=2')))).toBe(false);
  });

  it('writes new filters and drops the page, which means nothing in the new result set', () => {
    const params = new URLSearchParams('page=4&action=logout&unrelated=keep');
    expect(withFilters(params, { ...EMPTY_FILTERS, entity_type: 'company' })).toBe(
      '?unrelated=keep&entity_type=company',
    );
    expect(withFilters(new URLSearchParams('page=2&action=logout'), EMPTY_FILTERS)).toBe('');
  });
});

describe('auditQuery', () => {
  it('sends only the filters that are set, with the page', () => {
    expect(auditQuery({ ...EMPTY_FILTERS, user_id: 'u', to: '2026-03-31' }, 2, 20)).toEqual({
      page: '2',
      per_page: '20',
      user_id: 'u',
      to: '2026-03-31',
    });
  });
});

describe('fieldChanges — the technical detail view', () => {
  it('lays out old and new values field by field, keeping one-sided fields', () => {
    expect(
      fieldChanges(
        { correction_window_days: 7, note: 'old' },
        { correction_window_days: 10, name: { a: 1 } },
      ),
    ).toEqual([
      { field: 'correction_window_days', before: '7', after: '10' },
      { field: 'name', before: null, after: '{"a":1}' },
      { field: 'note', before: 'old', after: null },
    ]);
  });

  it('is empty when nothing was recorded', () => {
    expect(fieldChanges(null, null)).toEqual([]);
    expect(fieldChanges(['not', 'an', 'object'], 'x')).toEqual([]);
  });
});

describe('every action and record type has a sentence in both languages — DOCUMENT 27 RULE 25', () => {
  for (const locale of LOCALES) {
    const t = createTranslator(locale);
    it(`${locale}: every action sentence names the actor`, () => {
      for (const action of AUDIT_ACTIONS) {
        const text = t(actionKey(action), { actor: 'ACTOR' });
        expect(text, action).toContain('ACTOR');
      }
    });
    it(`${locale}: every record type has a label`, () => {
      for (const type of AUDIT_ENTITY_TYPES) {
        expect(t(entityTypeKey(type))).not.toBe('');
      }
    });
  }
});

describe('shortId', () => {
  it('keeps the distinguishing tail of a UUIDv7', () => {
    expect(shortId('01a0daeb-81dc-729c-9e3e-42fa3be59a6a')).toBe('3be59a6a');
  });
});

describe('links from an entity history panel', () => {
  it('opens the full audit log already filtered to the record', () => {
    expect(auditLogPath('ar', { entity_type: 'employee', entity_id: 'e1' })).toBe(
      '/ar/admin/settings/audit-log?entity_type=employee&entity_id=e1',
    );
    expect(auditLogPath('en')).toBe('/en/admin/settings/audit-log');
  });

  it('names the documented history endpoint', () => {
    expect(entityHistoryPath('employee', '01a0daeb-81dc-729c-9e3e-42fa3be59a6a')).toBe(
      '/audit-logs/entity/employee/01a0daeb-81dc-729c-9e3e-42fa3be59a6a',
    );
  });
});
