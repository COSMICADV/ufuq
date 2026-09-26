/**
 * Password hashing and opaque token generation — DOCUMENT 09 §2, §3.
 *
 * Argon2id is the DOCUMENT 09 §2 preferred algorithm. Session, reset and
 * invitation tokens are all the same shape: a high-entropy random secret
 * given to the caller, with only its SHA-256 hash ever stored (DOCUMENT 20
 * §8) — the database can leak without leaking a usable credential.
 */

import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed or foreign hash format is a verification failure, not a
    // thrown error the caller has to special-case.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * A precomputed Argon2id hash to verify against when no user was found, so a
 * login attempt against an unknown email costs the same wall-clock time as
 * one against a known email (DOCUMENT 09 §1 step 2).
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('ufuq-constant-time-comparison-placeholder');
  return dummyHash;
}

const TOKEN_BYTES = 32;

/** A cryptographically random, URL-safe opaque token — at least 256 bits of entropy. */
export function generateOpaqueToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** The only form of a token ever persisted (DOCUMENT 20 §8, DOCUMENT 09 §2). */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
