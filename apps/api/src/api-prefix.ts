/**
 * Fixed for the lifetime of V1 — DOCUMENT 08 §7.
 *
 * Split into its own module so it can be imported (by the test suite, which
 * needs the same prefix `supertest` requests against) without triggering
 * `main.ts`'s top-level `bootstrap()` call.
 */
export const API_PREFIX = 'api/v1';
