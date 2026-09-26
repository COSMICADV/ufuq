/**
 * Invitation tokens — DOCUMENT 09 §6, DOCUMENT 08 §4.1
 * `POST /auth/accept-invitation`, DOCUMENT 08 §4.3 `POST /employees/{id}/invite`.
 *
 * Phase 3 built acceptance; Phase 5 adds issuing, because issuing belongs to
 * employee creation and needs the `employees` table. Both halves live here so
 * the token lifecycle has one owner (DOCUMENT 27 RULE 6):
 *
 *   - One row per user (`invitations.user_id` is unique). Issuing again
 *     overwrites the hash and the expiry, which is what DOCUMENT 09 §6's "the
 *     old token is invalidated" means in a one-row model.
 *   - Only the SHA-256 hash is stored (DOCUMENT 06 §3.37, DOCUMENT 20 §8). The
 *     raw token is returned once, to the caller that emails it, and is never
 *     persisted, logged, audited or put in an API response.
 *   - 72-hour expiry (DOCUMENT 09 §6).
 *   - `preview` reads the same token *without* consuming it, so DOCUMENT 04 A4
 *     can name the company and the employee before the invitee commits to a
 *     password. It is the only read that does not spend the token.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateOpaqueToken, hashOpaqueToken, INVITATION_TOKEN_TTL_HOURS } from '@ufuq/auth';
import { generateId, lookupInvitationByTokenHash, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { PRISMA_CLIENT } from '../common/db.tokens.js';

export interface ConsumedInvitation {
  readonly companyId: string;
  readonly userId: string;
}

/**
 * What DOCUMENT 04 A4 shows read-only before the password is chosen — and
 * nothing else. An unredeemed token is held by whoever has the link, so this
 * deliberately carries no email, role, id or any other attribute of the
 * account: only enough for the invitee to recognise who invited them.
 */
export interface InvitationPreview {
  readonly companyName: string;
  /** Null when the invited user has no employee row (DOCUMENT 06 §3.6 allows it). */
  readonly employeeName: string | null;
}

export interface IssuedInvitation {
  /** The raw token — deliver it, then let it go. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface IssueInvitationParams {
  readonly companyId: string;
  readonly userId: string;
  /** The admin sending it (`invitations.invited_by`). */
  readonly invitedBy: string;
}

@Injectable()
export class InvitationService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Issue a fresh token for a user, inside the caller's transaction, so the
   * invitation exists exactly when the change that caused it commits.
   */
  async issue(tx: TenantClient, params: IssueInvitationParams): Promise<IssuedInvitation> {
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);
    const expiresAt = new Date(Date.now() + INVITATION_TOKEN_TTL_HOURS * 60 * 60_000);

    await tx.invitation.upsert({
      where: { userId: params.userId },
      create: {
        id: generateId(),
        companyId: params.companyId,
        userId: params.userId,
        tokenHash,
        invitedBy: params.invitedBy,
        expiresAt,
      },
      update: { tokenHash, invitedBy: params.invitedBy, expiresAt },
    });

    return { token, expiresAt };
  }

  /**
   * Make an outstanding invitation unusable — deactivating an employee who has
   * not accepted yet must not leave a working activation link in their inbox.
   */
  async expirePending(tx: TenantClient, userId: string): Promise<void> {
    await tx.invitation.updateMany({
      where: { userId, acceptedAt: null },
      data: { expiresAt: new Date() },
    });
  }

  /**
   * Resolve a token to the names DOCUMENT 04 A4 displays, **without** marking
   * it accepted — the invitee must still be able to redeem it afterwards.
   *
   * Returns null for an unknown, already-accepted or expired token, exactly as
   * `consume` does and without distinguishing them, so this endpoint tells a
   * guesser no more than the redemption itself would.
   */
  async preview(rawToken: string): Promise<InvitationPreview | null> {
    const tokenHash = hashOpaqueToken(rawToken);
    const record = await withPlatformContext(this.prisma, (tx) =>
      lookupInvitationByTokenHash(tx, tokenHash),
    );
    if (!record || record.acceptedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    return withTenant(this.prisma, record.companyId, async (tx) => {
      const [company, employee] = await Promise.all([
        tx.company.findUnique({ where: { id: record.companyId }, select: { name: true } }),
        tx.employee.findUnique({
          where: { userId: record.userId },
          select: { firstName: true, lastName: true },
        }),
      ]);
      if (!company) return null;
      return {
        companyName: company.name,
        employeeName: employee ? `${employee.firstName} ${employee.lastName}`.trim() : null,
      };
    });
  }

  /** Returns null for an unknown, already-accepted, or expired token — never which. */
  async consume(rawToken: string): Promise<ConsumedInvitation | null> {
    const tokenHash = hashOpaqueToken(rawToken);
    const record = await withPlatformContext(this.prisma, (tx) =>
      lookupInvitationByTokenHash(tx, tokenHash),
    );
    if (!record || record.acceptedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    await withTenant(this.prisma, record.companyId, (tx) =>
      tx.invitation.update({ where: { id: record.id }, data: { acceptedAt: new Date() } }),
    );

    return { companyId: record.companyId, userId: record.userId };
  }
}
