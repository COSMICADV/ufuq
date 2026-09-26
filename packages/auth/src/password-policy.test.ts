import { describe, expect, it } from 'vitest';

import { checkPasswordPolicy, isPasswordBreached, MIN_PASSWORD_LENGTH } from './password-policy.js';

describe('password policy — DOCUMENT 09 §2', () => {
  it('requires at least 10 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(checkPasswordPolicy('short1')).toContainEqual({ code: 'too_short' });
  });

  it('imposes no character-class rule', () => {
    // All lowercase, no digits, no symbols — long enough is enough.
    expect(checkPasswordPolicy('correcthorsebattery')).toEqual([]);
  });

  it('rejects a known-breached password even if long enough', () => {
    expect(isPasswordBreached('iloveyou1')).toBe(true);
    expect(checkPasswordPolicy('iloveyou1')).toContainEqual({ code: 'breached' });
  });

  it('is case-insensitive when matching the breach list', () => {
    expect(isPasswordBreached('PaSsWoRd999zzz')).toBe(false); // not a listed variant
    expect(isPasswordBreached('Password1')).toBe(true);
  });

  it('accepts a long, unlisted password', () => {
    expect(checkPasswordPolicy('a-genuinely-uncommon-passphrase-42')).toEqual([]);
  });
});
