/**
 * Session creation, validation, rotation and revocation — DOCUMENT 09 §3,
 * OD-02.
 *
 * One `sessions` table serves both clients (OD-02): a web row carries only
 * `tokenHash` and rides in an httpOnly cookie; a mobile row also carries
 * `refreshTokenHash` and rides as a Bearer access token, refreshed through
 * `POST /auth/refresh`. Every raw token this service hands out is a
 * high-entropy opaque secret that is never itself persisted — only its
 * SHA-256 hash is (DOCUMENT 20 §8) — so a database leak does not leak a
 * usable credential.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  generateOpaqueToken,
  hashOpaqueToken,
  SESSION_ABSOLUTE_TIMEOUT_MINUTES_DEFAULT,
  SESSION_ABSOLUTE_TIMEOUT_MINUTES_REMEMBERED,
  SESSION_IDLE_TIMEOUT_MINUTES,
} from '@ufuq/auth';
import {
  generateId,
  lookupSessionByRefreshTokenHash,
  lookupSessionByTokenHash,
  withPlatformContext,
  withTenant,
} from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { PRISMA_CLIENT } from '../common/db.tokens.js';

export type ClientType = 'web' | 'mobile';

export interface CreateSessionParams {
  readonly userId: string;
  readonly companyId: string;
  readonly clientType: ClientType;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Web only. Mobile sessions always get the longer, "remembered" window — see the Phase 3 report. */
  readonly rememberMe: boolean;
}

export interface CreatedSession {
  readonly sessionId: string;
  readonly token: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly clientType: ClientType;
}

function absoluteExpiry(rememberMe: boolean): Date {
  const minutes = rememberMe
    ? SESSION_ABSOLUTE_TIMEOUT_MINUTES_REMEMBERED
    : SESSION_ABSOLUTE_TIMEOUT_MINUTES_DEFAULT;
  return new Date(Date.now() + minutes * 60_000);
}

@Injectable()
export class SessionService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async create(params: CreateSessionParams): Promise<CreatedSession> {
    const token = generateOpaqueToken();
    const refreshToken = params.clientType === 'mobile' ? generateOpaqueToken() : null;
    // Mobile sessions have no login-time "remember me" checkbox, so they
    // always get the longer absolute window (DOCUMENT 09 §3's two windows
    // are described for the web login form; a mobile app that is not
    // reopened for weeks should not need a fresh login any more than a
    // "remembered" browser would).
    const expiresAt = absoluteExpiry(params.clientType === 'mobile' ? true : params.rememberMe);
    const sessionId = generateId();

    await withTenant(this.prisma, params.companyId, (tx) =>
      tx.session.create({
        data: {
          id: sessionId,
          companyId: params.companyId,
          userId: params.userId,
          clientType: params.clientType,
          tokenHash: hashOpaqueToken(token),
          refreshTokenHash: refreshToken ? hashOpaqueToken(refreshToken) : null,
          rememberMe: params.rememberMe,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          expiresAt,
        },
      }),
    );

    return { sessionId, token, refreshToken, expiresAt };
  }

  /**
   * Resolves a bearer/cookie token to a live session, applying both timeout
   * rules (DOCUMENT 09 §3): the absolute expiry fixed at creation, and the
   * idle timeout measured from `lastSeenAt`. A valid session has its
   * `lastSeenAt` slid forward to now as a side effect — that is what makes
   * the idle timeout a sliding window rather than a second absolute one.
   * Returns null for anything invalid; the guard is responsible for turning
   * that into a 401, not this service.
   */
  async resolveAndTouch(rawToken: string): Promise<ResolvedSession | null> {
    const tokenHash = hashOpaqueToken(rawToken);

    // No tenant is known yet — resolving one is the point of this call
    // (see @ufuq/db's `withPlatformContext` and DOCUMENT 09 §7).
    const session = await withPlatformContext(this.prisma, (tx) =>
      lookupSessionByTokenHash(tx, tokenHash),
    );
    if (!session || session.revokedAt !== null) {
      return null;
    }

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      return null;
    }
    const idleDeadline = session.lastSeenAt.getTime() + SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
    if (idleDeadline <= now) {
      return null;
    }

    await withTenant(this.prisma, session.companyId, (tx) =>
      tx.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }),
    );

    return {
      sessionId: session.id,
      companyId: session.companyId,
      userId: session.userId,
      clientType: session.clientType,
    };
  }

  /** `POST /auth/refresh` (mobile). Rotates both tokens — DOCUMENT 09 §3 "rotation". */
  async rotateForRefresh(rawRefreshToken: string): Promise<CreatedSession | null> {
    const refreshTokenHash = hashOpaqueToken(rawRefreshToken);
    const session = await withPlatformContext(this.prisma, (tx) =>
      lookupSessionByRefreshTokenHash(tx, refreshTokenHash),
    );
    if (!session || session.revokedAt !== null || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    const token = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();

    await withTenant(this.prisma, session.companyId, (tx) =>
      tx.session.update({
        where: { id: session.id },
        data: {
          tokenHash: hashOpaqueToken(token),
          refreshTokenHash: hashOpaqueToken(refreshToken),
          lastSeenAt: new Date(),
        },
      }),
    );

    return { sessionId: session.id, token, refreshToken, expiresAt: session.expiresAt };
  }

  /** Logout, or any other single-session revocation. */
  async revoke(companyId: string, sessionId: string): Promise<void> {
    await withTenant(this.prisma, companyId, (tx) =>
      tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }),
    );
  }

  /**
   * DOCUMENT 09 §3 "sign out everywhere", and the DOCUMENT 09 §3 rule that
   * a password change invalidates every other session. `exceptSessionId` is
   * how change-password can revoke every session but the one making the
   * request.
   */
  async revokeAllForUser(
    companyId: string,
    userId: string,
    exceptSessionId?: string,
  ): Promise<void> {
    await withTenant(this.prisma, companyId, (tx) =>
      this.revokeAllForUserIn(tx, userId, exceptSessionId),
    );
  }

  /**
   * The same revocation, inside a transaction the caller already holds —
   * DOCUMENT 09 §6: deactivation and role change "invalidate sessions", and
   * they must do it atomically with the change that requires it. Returns how
   * many live sessions were revoked.
   */
  async revokeAllForUserIn(
    tx: TenantClient,
    userId: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
