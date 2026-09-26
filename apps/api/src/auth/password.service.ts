/**
 * Password hashing, policy, and reset-token lifecycle — DOCUMENT 09 §2.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  checkPasswordPolicy,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  verifyPassword,
} from '@ufuq/auth';
import type { PasswordPolicyViolation } from '@ufuq/auth';
import {
  generateId,
  lookupPasswordResetTokenByHash,
  withPlatformContext,
  withTenant,
} from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';

import { PRISMA_CLIENT } from '../common/db.tokens.js';

export interface ConsumedResetToken {
  readonly id: string;
  readonly companyId: string;
  readonly userId: string;
}

@Injectable()
export class PasswordService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  hash(password: string): Promise<string> {
    return hashPassword(password);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return verifyPassword(hash, password);
  }

  checkPolicy(password: string): readonly PasswordPolicyViolation[] {
    return checkPasswordPolicy(password);
  }

  /**
   * A new request invalidates the previous unused one — DOCUMENT 09 §2's
   * "single-use token" applies to the *current* token, not to history,
   * so the old row is marked used rather than deleted (DOCUMENT 06 §6).
   */
  async createResetToken(companyId: string, userId: string): Promise<string> {
    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_MINUTES * 60_000);

    await withTenant(this.prisma, companyId, async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          id: generateId(),
          companyId,
          userId,
          tokenHash: hashOpaqueToken(token),
          expiresAt,
        },
      });
    });

    return token;
  }

  /** Returns null for an unknown, already-used, or expired token — never which. */
  async consumeResetToken(rawToken: string): Promise<ConsumedResetToken | null> {
    const tokenHash = hashOpaqueToken(rawToken);
    const record = await withPlatformContext(this.prisma, (tx) =>
      lookupPasswordResetTokenByHash(tx, tokenHash),
    );
    if (!record || record.usedAt !== null || record.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    await withTenant(this.prisma, record.companyId, (tx) =>
      tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    );

    return { id: record.id, companyId: record.companyId, userId: record.userId };
  }
}
