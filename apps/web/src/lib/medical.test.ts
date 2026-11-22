import { describe, expect, it } from 'vitest';

import { ageFrom, MEDICAL_PERMISSIONS, PERMISSION_GROUPS } from './medical';

describe('medical helpers', () => {
  it('computes whole years of age', () => {
    const today = new Date(2026, 10, 22);
    expect(ageFrom('1988-04-12', today)).toBe(38);
    expect(ageFrom('1988-11-23', today)).toBe(37);
    expect(ageFrom('1988-11-22', today)).toBe(38);
    expect(ageFrom(null, today)).toBeNull();
  });
  it('draws every permission exactly once', () => {
    const drawn = PERMISSION_GROUPS.flatMap(([, keys]) => keys);
    expect([...drawn].sort()).toEqual([...MEDICAL_PERMISSIONS].sort());
  });
});
