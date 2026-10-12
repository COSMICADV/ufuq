/**
 * `Idempotency-Key` — DOCUMENT 08 §8, DOCUMENT 15 "API requirements",
 * DOCUMENT 26 ("repeat a financial POST with the same key and assert one
 * record, one result").
 *
 * A key is scoped to the company, the user and the endpoint. Within 24 hours,
 * repeating it with the same request replays the original resource instead of
 * creating a second one. Repeating it with a materially different request is
 * refused (422 `IDEMPOTENCY_KEY_REUSED`), because silently answering a
 * different request with an old result is worse than saying no.
 *
 * **Concurrency.** The key row is written first, inside the business
 * transaction, holding the resource id the transaction is about to create.
 * A concurrent request with the same key blocks on the unique index until
 * the first commits, then fails with a unique violation. The caller catches
 * it and replays (`replayAfterConflict`). Two requests can never both create.
 * If the first transaction rolls back, its key row goes with it, and the
 * retry is a fresh request.
 */

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';

import { AppException } from './app-exception.js';
import { ERROR_CODES } from './errors.js';

export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_MAX = 255;

export interface IdempotencyRequest {
  readonly key: string;
  readonly scope: string;
  readonly hash: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Null when no key was sent; 422 when the header is not a usable key. */
export function idempotencyRequest(
  header: string | undefined,
  scope: string,
  body: unknown,
): IdempotencyRequest | null {
  if (header === undefined) return null;
  const key = header.trim();
  if (key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX) {
    throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
      fields: { 'Idempotency-Key': ['invalid'] },
    });
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(canonical(body)))
    .digest('hex');
  return { key, scope, hash };
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class IdempotencyService {
  /**
   * The resource a fresh, matching key already produced, or null. A fresh key
   * with a different request is refused.
   */
  async replay(
    tx: TenantClient,
    ctx: AuthContext,
    request: IdempotencyRequest,
    now: Date,
  ): Promise<string | null> {
    const row = await tx.idempotencyKey.findUnique({
      where: {
        companyId_userId_scope_key: {
          companyId: ctx.companyId,
          userId: ctx.userId,
          scope: request.scope,
          key: request.key,
        },
      },
    });
    if (row === null || now.getTime() - row.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS) {
      return null;
    }
    if (row.requestHash !== request.hash) {
      throw new AppException(ERROR_CODES.IDEMPOTENCY_KEY_REUSED, 422);
    }
    return row.resourceId;
  }

  /**
   * Claim the key for `resourceId` before creating it. An expired row for the
   * same key is reused (the app role has no DELETE); a live one makes this
   * throw a unique violation, which the caller turns into a replay.
   */
  async claim(
    tx: TenantClient,
    ctx: AuthContext,
    request: IdempotencyRequest,
    resourceId: string,
    now: Date,
  ): Promise<void> {
    const expired = await tx.idempotencyKey.updateMany({
      where: {
        companyId: ctx.companyId,
        userId: ctx.userId,
        scope: request.scope,
        key: request.key,
        createdAt: { lt: new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS) },
      },
      data: { requestHash: request.hash, resourceId, createdAt: now },
    });
    if (expired.count > 0) return;
    await tx.idempotencyKey.create({
      data: {
        id: generateId(),
        companyId: ctx.companyId,
        userId: ctx.userId,
        scope: request.scope,
        key: request.key,
        requestHash: request.hash,
        resourceId,
        createdAt: now,
      },
    });
  }
}
