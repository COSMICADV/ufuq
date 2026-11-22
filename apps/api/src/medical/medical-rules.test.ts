import { describe, expect, it } from 'vitest';

import { MEDICAL_PERMISSIONS, nextFileNumber, ROLE_PRESETS, widest } from './medical-rules.js';

describe('medical rules', () => {
  it('numbers patient files in sequence', () => {
    expect(nextFileNumber(null)).toBe('P-000001');
    expect(nextFileNumber('P-000041')).toBe('P-000042');
  });
  it('keeps clinical content away from reception and finance by default', () => {
    for (const role of ['reception', 'finance', 'administration'] as const) {
      const keys = ROLE_PRESETS[role].map(([k]) => k);
      expect(keys.filter((k) => k.startsWith('documents') || k === 'visits.clinical' || k === 'imaging.view' || k === 'labs.view')).toEqual([]);
    }
  });
  it('presets only name known permissions; a doctor works on assigned patients', () => {
    for (const grants of Object.values(ROLE_PRESETS)) {
      for (const [key] of grants) expect(MEDICAL_PERMISSIONS).toContain(key);
    }
    expect(ROLE_PRESETS.doctor.every(([, scope]) => scope === 'assigned')).toBe(true);
  });
  it('takes the wider scope', () => {
    expect(widest('assigned', 'all')).toBe('all');
    expect(widest(undefined, 'assigned')).toBe('assigned');
    expect(widest(undefined, undefined)).toBeUndefined();
  });
});
