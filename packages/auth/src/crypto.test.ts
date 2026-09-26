import { describe, expect, it } from 'vitest';

import {
  dummyPasswordHash,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  timingSafeEqualStrings,
  verifyPassword,
} from './crypto.js';

describe('password hashing — DOCUMENT 09 §2', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('a-real-password-123');
    expect(hash).not.toContain('a-real-password-123');
    expect(await verifyPassword(hash, 'a-real-password-123')).toBe(true);
    expect(await verifyPassword(hash, 'a-wrong-password-123')).toBe(false);
  });

  it('produces an argon2id hash', async () => {
    const hash = await hashPassword('a-real-password-123');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('never throws on a malformed stored hash — a verification failure, not an exception', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
  });

  it('exposes a stable dummy hash for constant-time comparison on unknown emails', async () => {
    const first = await dummyPasswordHash();
    const second = await dummyPasswordHash();
    expect(first).toBe(second);
    expect(first).toMatch(/^\$argon2id\$/);
  });
});

describe('opaque tokens — DOCUMENT 09 §2, §3, DOCUMENT 20 §8', () => {
  it('generates high-entropy, unique tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });

  it('hashes deterministically, so a hash lookup can find the token again', () => {
    const token = generateOpaqueToken();
    expect(hashOpaqueToken(token)).toBe(hashOpaqueToken(token));
  });

  it('never stores the raw token inside its own hash', () => {
    const token = generateOpaqueToken();
    expect(hashOpaqueToken(token)).not.toContain(token);
  });
});

describe('timingSafeEqualStrings', () => {
  it('matches equal strings', () => {
    expect(timingSafeEqualStrings('abc123', 'abc123')).toBe(true);
  });

  it('rejects different strings, including different lengths', () => {
    expect(timingSafeEqualStrings('abc123', 'abc124')).toBe(false);
    expect(timingSafeEqualStrings('abc123', 'abc12')).toBe(false);
  });
});
