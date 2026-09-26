import { describe, expect, it } from 'vitest';

import { single } from './envelope.js';
import { codeForStatus, ERROR_CODES, errorBody } from './errors.js';

describe('the response envelope (DOCUMENT 08 §2)', () => {
  it('wraps a single resource with its meta', () => {
    expect(single({ id: 1 }, { locale: 'ar' })).toEqual({
      data: { id: 1 },
      meta: { locale: 'ar' },
    });
  });
});

describe('error bodies (DOCUMENT 08 §2)', () => {
  it('carries both languages for every code', () => {
    for (const code of Object.values(ERROR_CODES)) {
      const body = errorBody(code);
      expect(body.code).toBe(code);
      expect(body.message_ar.length).toBeGreaterThan(0);
      expect(body.message_en.length).toBeGreaterThan(0);
      expect(body.message_ar).not.toBe(body.message_en);
    }
  });

  it('omits the fields key when there are no field errors', () => {
    expect('fields' in errorBody(ERROR_CODES.NOT_FOUND)).toBe(false);
  });

  it('carries field errors when they are given', () => {
    expect(errorBody(ERROR_CODES.NOT_FOUND, { email: ['already_taken'] }).fields).toEqual({
      email: ['already_taken'],
    });
  });

  it('maps a status to its code, and anything unexpected to an internal error', () => {
    expect(codeForStatus(404)).toBe(ERROR_CODES.NOT_FOUND);
    expect(codeForStatus(500)).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(codeForStatus(418)).toBe(ERROR_CODES.INTERNAL_ERROR);
  });
});
