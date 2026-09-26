import { describe, expect, it } from 'vitest';

import { isPermissionKey, PERMISSIONS } from './permissions.js';

describe('permission catalogue — DOCUMENT 02 §4', () => {
  it('has no duplicate keys', () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every key follows module.action', () => {
    for (const p of PERMISSIONS) {
      expect(p.key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('every permission has a non-empty bilingual description', () => {
    for (const p of PERMISSIONS) {
      expect(p.descriptionEn.length).toBeGreaterThan(0);
      expect(p.descriptionAr.length).toBeGreaterThan(0);
    }
  });

  it('recognises a real key and rejects an unknown one', () => {
    expect(isPermissionKey('employee.view')).toBe(true);
    expect(isPermissionKey('employee.delete_everything')).toBe(false);
  });
});
