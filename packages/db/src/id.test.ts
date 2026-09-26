import { describe, expect, it } from 'vitest';

import { generateId } from './id.js';

describe('generateId — OD-12', () => {
  it('produces a well-formed UUID', () => {
    expect(generateId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('produces a version-7 UUID (time-ordered, non-guessable)', () => {
    const id = generateId();
    expect(id[14]).toBe('7');
  });

  it('produces distinct ids on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });

  it('is monotonically time-ordered for ids generated in sequence', () => {
    const a = generateId();
    const b = generateId();
    expect(a < b).toBe(true);
  });
});
