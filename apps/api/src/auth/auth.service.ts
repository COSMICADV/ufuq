/**
 * Login, logout, password change/reset, invitation acceptance, and refresh —
 * DOCUMENT 09.
 *
 * Every branch that fails authentication throws {@link AppException} with a
 * specific code (DOCUMENT 09 §1: wrong email and wrong password share one
 * message; lockout, an inactive account, and an inactive company each get
 * their own) and, wherever a real user/company is known, writes an audit
 * record (DOCUMENT 21). Where the action changes state (a login's counters,
 * a revoked session, a new password, an accepted invitation), the record is
 * written after that change commits (`AuditDispatcher`). A login refused
 * before any counter moves, and a reset request, change nothing besides the
 * audit, so those write it directly.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  dummyPasswordHash,
  LOGIN_LOCKOUT_DURATION_MINUTES,
  LOGIN_LOCKOUT_WINDOW_MINUTES,
  LOGIN_MAX_FAILURES,
  LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  LOGIN_RATE_LIMIT_WINDOW_MINUTES,
  FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
  FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MINUTES,
  isSystemRoleKey,
  permissionsForRole,
  verifyPassword,
} from '@ufuq/auth';
import type { PermissionScope } from '@ufuq/auth';
import { lookupUsersByEmail, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import type { AuthLoginLookupRow } from '@ufuq/db';

import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';

import { AuditDispatcher } from './audit-dispatcher.js';
import { AuditService } from './audit.service.js';

import type { InvitationPreview } from './invitation.service.js';

import { InvitationService } from './invitation.service.js';

import { PasswordService } from './password.service.js';

import { RateLimitService } from './rate-limit.service.js';
import type { ClientType, CreatedSession } from './session.service.js';

import { SessionService } from './session.service.js';

export interface RequestContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AuthenticatedUser {
  readonly id: string;
  readonly companyId: string;
  readonly email: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly permissions: ReadonlyMap<string, PermissionScope>;
}

export interface LoginResult {
  readonly user: AuthenticatedUser;
  readonly session: CreatedSession;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Every dependency is injected by explicit token (@Inject(ClassName)),
  // this codebase's convention (see `app.tokens.ts`) — and, for these
  // specifically, a necessity: vitest's esbuild-based transform does not
  // emit `design:paramtypes` metadata, so bare `private readonly x: X`
  // constructor injection silently fails to resolve `X` under the test
  // runner even though it works under `tsc`+`ts-node`. Explicit tokens
  // sidestep the whole question.
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    /** Audit-only writes (a refused login, a reset request): there is no business change to commit first. */
    @Inject(AuditService) private readonly audit: AuditService,
    /** Every transaction that changes state audits through this, after commit (DOCUMENT 21 §1–§3). */
    @Inject(AuditDispatcher) private readonly postCommit: AuditDispatcher,
  ) {}

  async login(
    email: string,
    password: string,
    rememberMe: boolean,
    clientType: ClientType,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    await this.enforceLoginRateLimit(email, ctx.ipAddress);

    const candidates = await withPlatformContext(this.prisma, (tx) =>
      lookupUsersByEmail(tx, email),
    );

    if (candidates.length === 0) {
      // DOCUMENT 09 §1 step 2: run the same-cost comparison anyway so a
      // request against an unknown email takes the same wall-clock time as
      // one against a known email. There is no company to scope an audit
      // row to (every `audit_logs` row requires one), so this specific
      // failure is a log line, not a DOCUMENT 21 record.
      await verifyPassword(await dummyPasswordHash(), password);
      this.logger.warn(`login failed: no account for this email`);
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 401);
    }

    let lastError: AppException = new AppException(ERROR_CODES.INVALID_CREDENTIALS, 401);
    for (const candidate of candidates) {
      try {
        const user = await this.attemptLogin(candidate, password, ctx);
        const session = await this.sessions.create({
          userId: user.id,
          companyId: user.companyId,
          clientType,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
          rememberMe,
        });
        return { user, session };
      } catch (error) {
        if (error instanceof AppException) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    // Every candidate — there is normally exactly one; DOCUMENT 06 §3.2
    // allows more only because the same email may exist in two companies —
    // refused. Whichever specific reason the *last* one gave (locked,
    // deactivated, wrong password …) is as good a message as any: none of
    // them confirm which candidate, if any, the caller actually intended.
    throw lastError;
  }

  private async attemptLogin(
    candidate: AuthLoginLookupRow,
    password: string,
    ctx: RequestContext,
  ): Promise<AuthenticatedUser> {
    if (candidate.lockedUntil && candidate.lockedUntil.getTime() > Date.now()) {
      await withTenant(this.prisma, candidate.companyId, (tx) =>
        this.audit.record(tx, {
          companyId: candidate.companyId,
          userId: candidate.id,
          action: 'LOGIN_LOCKED',
          entityType: 'user',
          entityId: candidate.id,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        }),
      );
      throw new AppException(ERROR_CODES.ACCOUNT_LOCKED, 401);
    }

    const passwordOk = candidate.passwordHash
      ? await this.passwords.verify(candidate.passwordHash, password)
      : false;

    if (!passwordOk) {
      await this.registerFailedAttempt(candidate, ctx);
      throw new AppException(ERROR_CODES.INVALID_CREDENTIALS, 401);
    }

    // DOCUMENT 09 §1 steps 4–5: status checks run only once the password is
    // known to be correct, so a wrong password against an invited or
    // deactivated account still reports as a wrong password, not as a hint
    // that the account is in some other state.
    if (candidate.status === 'invited') {
      await this.auditPlainFailure(candidate, ctx);
      throw new AppException(ERROR_CODES.ACCOUNT_NOT_ACTIVATED, 401);
    }
    if (candidate.status === 'deactivated') {
      await this.auditPlainFailure(candidate, ctx);
      throw new AppException(ERROR_CODES.ACCOUNT_DEACTIVATED, 401);
    }
    if (candidate.companyStatus !== 'active') {
      await this.auditPlainFailure(candidate, ctx);
      throw new AppException(ERROR_CODES.COMPANY_INACTIVE, 401);
    }

    return this.postCommit.withTenant(candidate.companyId, async (tx) => {
      await tx.user.update({
        where: { id: candidate.id },
        data: {
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });
      await this.postCommit.record(tx, {
        companyId: candidate.companyId,
        userId: candidate.id,
        action: 'LOGIN_SUCCESS',
        entityType: 'user',
        entityId: candidate.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      const role = await tx.role.findUniqueOrThrow({ where: { id: candidate.roleId } });
      if (!isSystemRoleKey(role.key)) {
        // Cannot happen in V1 — every role a user can hold is one of the
        // four seeded system roles (DOCUMENT 02 §2) — but a role key
        // @ufuq/auth's catalogue does not recognise must fail loudly rather
        // than silently granting zero permissions.
        throw new Error(`Unrecognised role key: ${role.key}`);
      }
      return {
        id: candidate.id,
        companyId: candidate.companyId,
        email: candidate.email,
        roleId: role.id,
        roleKey: role.key,
        permissions: permissionsForRole(role.key),
      };
    });
  }

  /** DOCUMENT 09 §1 "Failure handling": 5 failures within 15 minutes locks the account for 15 minutes. */
  private async registerFailedAttempt(
    candidate: AuthLoginLookupRow,
    ctx: RequestContext,
  ): Promise<void> {
    await this.postCommit.withTenant(candidate.companyId, async (tx) => {
      const now = new Date();
      const withinWindow =
        candidate.lastFailedLoginAt !== null &&
        now.getTime() - candidate.lastFailedLoginAt.getTime() <=
          LOGIN_LOCKOUT_WINDOW_MINUTES * 60_000;
      const nextCount = withinWindow ? candidate.failedLoginCount + 1 : 1;
      const shouldLock = nextCount >= LOGIN_MAX_FAILURES;

      await tx.user.update({
        where: { id: candidate.id },
        data: {
          failedLoginCount: nextCount,
          lastFailedLoginAt: now,
          lockedUntil: shouldLock
            ? new Date(now.getTime() + LOGIN_LOCKOUT_DURATION_MINUTES * 60_000)
            : null,
        },
      });
      await this.postCommit.record(tx, {
        companyId: candidate.companyId,
        userId: candidate.id,
        action: shouldLock ? 'LOGIN_LOCKED' : 'LOGIN_FAILED',
        entityType: 'user',
        entityId: candidate.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    });
  }

  private async auditPlainFailure(
    candidate: AuthLoginLookupRow,
    ctx: RequestContext,
  ): Promise<void> {
    await withTenant(this.prisma, candidate.companyId, (tx) =>
      this.audit.record(tx, {
        companyId: candidate.companyId,
        userId: candidate.id,
        action: 'LOGIN_FAILED',
        entityType: 'user',
        entityId: candidate.id,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      }),
    );
  }

  private async enforceLoginRateLimit(email: string, ipAddress: string | null): Promise<void> {
    const windowSeconds = LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60;
    const [byIp, byEmail] = await Promise.all([
      this.rateLimit.consume(
        `login:ip:${ipAddress ?? 'unknown'}`,
        LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
        windowSeconds,
      ),
      this.rateLimit.consume(`login:email:${email}`, LOGIN_RATE_LIMIT_MAX_ATTEMPTS, windowSeconds),
    ]);
    const blocked = !byIp.allowed ? byIp : !byEmail.allowed ? byEmail : null;
    if (blocked) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: blocked.retryAfterSeconds,
      });
    }
  }

  async logout(
    companyId: string,
    userId: string,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<void> {
    await this.postCommit.withTenant(companyId, async (tx) => {
      await tx.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
      await this.postCommit.record(tx, {
        companyId,
        userId,
        action: 'LOGOUT',
        entityType: 'session',
        entityId: sessionId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    });
  }

  /** DOCUMENT 08 §4.1: always succeeds from the caller's point of view, regardless of whether the email exists. */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const limit = await this.rateLimit.consume(
      `forgot-password:email:${email}`,
      FORGOT_PASSWORD_RATE_LIMIT_MAX_ATTEMPTS,
      FORGOT_PASSWORD_RATE_LIMIT_WINDOW_MINUTES * 60,
    );
    if (!limit.allowed) {
      // Still no acknowledgement of whether the email exists — DOCUMENT 08
      // §4.1 — but a 429 here is a normal, expected abuse control, not a
      // confirmation of anything about the account.
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const candidates = await withPlatformContext(this.prisma, (tx) =>
      lookupUsersByEmail(tx, email),
    );

    for (const candidate of candidates) {
      if (candidate.status !== 'active' || candidate.companyStatus !== 'active') {
        continue;
      }
      // DOCUMENT 25 Phase 15 owns actually delivering this token (email);
      // see the Phase 3 report. The token is created and auditable now so
      // the rest of the reset flow is fully built and testable.
      const token = await this.passwords.createResetToken(candidate.companyId, candidate.id);
      await withTenant(this.prisma, candidate.companyId, (tx) =>
        this.audit.record(tx, {
          companyId: candidate.companyId,
          userId: candidate.id,
          action: 'PASSWORD_RESET_REQUESTED',
          entityType: 'user',
          entityId: candidate.id,
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        }),
      );
      void token; // not returned to the caller (DOCUMENT 08 §4.1) or logged (DOCUMENT 20 §8)
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const violations = this.passwords.checkPolicy(newPassword);
    if (violations.length > 0) {
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { newPassword: violations.map((v) => v.code) },
      });
    }

    const consumed = await this.passwords.consumeResetToken(token);
    if (!consumed) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 400);
    }

    const passwordHash = await this.passwords.hash(newPassword);
    await this.postCommit.withTenant(consumed.companyId, async (tx) => {
      await tx.user.update({
        where: { id: consumed.userId },
        data: { passwordHash, failedLoginCount: 0, lastFailedLoginAt: null, lockedUntil: null },
      });
      await this.postCommit.record(tx, {
        companyId: consumed.companyId,
        userId: consumed.userId,
        action: 'PASSWORD_RESET_COMPLETED',
        entityType: 'user',
        entityId: consumed.userId,
      });
    });
    // No "current" session exists during a reset — every session dies.
    await this.sessions.revokeAllForUser(consumed.companyId, consumed.userId);
  }

  /**
   * DOCUMENT 04 A4 — the company and employee name the acceptance page shows
   * read-only, resolved from the token without spending it.
   *
   * Rate limited per IP on the same budget as login: an unredeemed invitation
   * token is a bearer credential, and without a throttle this would be the one
   * endpoint where a guesser could test candidates at no cost and be told, for
   * free, which company a hit belongs to. A miss is the same opaque
   * `TOKEN_INVALID` the redemption gives, so a hit is the only thing that
   * differs — which is precisely why the attempts have to be bounded.
   */
  async previewInvitation(token: string, ipAddress: string | null): Promise<InvitationPreview> {
    const limit = await this.rateLimit.consume(
      `invitation-preview:ip:${ipAddress ?? 'unknown'}`,
      LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60,
    );
    if (!limit.allowed) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }

    const preview = await this.invitations.preview(token);
    if (!preview) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 400);
    }
    return preview;
  }

  async acceptInvitation(token: string, password: string): Promise<void> {
    const violations = this.passwords.checkPolicy(password);
    if (violations.length > 0) {
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { password: violations.map((v) => v.code) },
      });
    }

    const consumed = await this.invitations.consume(token);
    if (!consumed) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 400);
    }

    const passwordHash = await this.passwords.hash(password);
    await this.postCommit.withTenant(consumed.companyId, async (tx) => {
      await tx.user.update({
        where: { id: consumed.userId },
        data: { passwordHash, status: 'active', emailVerifiedAt: new Date() },
      });
      await this.postCommit.record(tx, {
        companyId: consumed.companyId,
        userId: consumed.userId,
        action: 'INVITATION_ACCEPTED',
        entityType: 'user',
        entityId: consumed.userId,
      });
    });
  }

  async changePassword(
    ctx: { companyId: string; userId: string; sessionId: string },
    currentPassword: string,
    newPassword: string,
    request: RequestContext,
  ): Promise<void> {
    const violations = this.passwords.checkPolicy(newPassword);
    if (violations.length > 0) {
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { newPassword: violations.map((v) => v.code) },
      });
    }

    const passwordHash = await this.postCommit.withTenant(ctx.companyId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: ctx.userId } });
      const currentOk = user.passwordHash
        ? await this.passwords.verify(user.passwordHash, currentPassword)
        : false;
      if (!currentOk) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
          fields: { currentPassword: ['incorrect'] },
        });
      }
      const hash = await this.passwords.hash(newPassword);
      await tx.user.update({ where: { id: ctx.userId }, data: { passwordHash: hash } });
      await this.postCommit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'PASSWORD_CHANGED',
        entityType: 'user',
        entityId: ctx.userId,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
      });
      return hash;
    });
    void passwordHash;

    // DOCUMENT 09 §2: "invalidates all other sessions" — the session making
    // this authenticated request is the one exception.
    await this.sessions.revokeAllForUser(ctx.companyId, ctx.userId, ctx.sessionId);
  }

  async refresh(refreshToken: string): Promise<CreatedSession> {
    const rotated = await this.sessions.rotateForRefresh(refreshToken);
    if (!rotated) {
      throw new AppException(ERROR_CODES.UNAUTHENTICATED, 401);
    }
    return rotated;
  }
}
