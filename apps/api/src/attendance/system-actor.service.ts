/**
 * The designated system actor — DOCUMENT 21 "Record content".
 *
 * DOCUMENT 21 requires an acting user on every audit record and forbids null.
 * Work the system does on its own — generated weekends and holidays, the
 * nightly absence job, a forgotten record closed at the scheduled end
 * (DOCUMENT 12 rules 9 and 10) — has no acting human, and naming a real
 * administrator instead reads as though that person did something they did
 * not.
 *
 * **It can never authenticate**, and that is a property of the database rather
 * than a promise made here:
 *
 *   - `auth_lookup_login` does not return system rows, so the single entry
 *     point for `POST /auth/login` *and* `POST /auth/forgot-password` cannot
 *     see the account at all — it is not refused, it is invisible.
 *   - `users_system_has_no_password` refuses any write that would give it a
 *     password hash, which is what accepting an invitation would otherwise do.
 *   - `users_system_is_not_invited` pins its status to `deactivated`, so
 *     nothing treats it as an account awaiting activation.
 *   - Without a login there is no session row, so no request can ever run as
 *     it.
 *
 * Find-or-create rather than a seeded row, because a company created after the
 * migration must still get one, and `users_one_system_actor_per_company` (a
 * partial unique index) is what makes the create idempotent: two workers
 * racing produce one row and one caught unique violation, not two actors.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';

import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { TenantScopedService } from '../company-structure/tenant-scoped.service.js';
import { isUniqueViolation } from '../company-structure/tenant-scoped.service.js';
import type { PrismaClient } from '@ufuq/db';

/**
 * RFC 2606 reserves `.invalid` so that it can never resolve. The column is NOT
 * NULL and unique per company; this satisfies both without creating an address
 * anybody could write to.
 */
export const SYSTEM_ACTOR_EMAIL = 'system@ufuq.invalid';

/**
 * The lowest-privilege system role (DOCUMENT 02 §2). `users.role_id` is NOT
 * NULL, and inventing a fifth role to hold no permissions would be inventing a
 * role (DOCUMENT 27 RULE 2). Nothing ever resolves these permissions, because
 * nothing can ever run as this account.
 */
export const SYSTEM_ACTOR_ROLE_KEY = 'employee';

export class SystemActorUnavailableError extends Error {
  constructor(readonly companyId: string) {
    super(
      `Company ${companyId} has no system actor and the '${SYSTEM_ACTOR_ROLE_KEY}' system role is not seeded.`,
    );
    this.name = 'SystemActorUnavailableError';
  }
}

@Injectable()
export class SystemActorService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  /**
   * The company's system actor, created if it does not exist yet.
   *
   * Runs inside the caller's tenant transaction so a generated row and the
   * actor its audit record names commit together.
   */
  async resolve(tx: TenantClient, companyId: string): Promise<string> {
    const existing = await tx.user.findFirst({
      where: { isSystem: true },
      select: { id: true },
    });
    if (existing !== null) {
      return existing.id;
    }

    const role = await tx.role.findFirst({
      where: { key: SYSTEM_ACTOR_ROLE_KEY, companyId: null },
      select: { id: true },
    });
    if (role === null) {
      // Refused rather than falling back to an administrator: a wrong actor on
      // an audit record is worse than a job that says why it stopped.
      throw new SystemActorUnavailableError(companyId);
    }

    try {
      const created = await tx.user.create({
        data: {
          id: generateId(),
          companyId,
          email: SYSTEM_ACTOR_EMAIL,
          passwordHash: null,
          roleId: role.id,
          status: 'deactivated',
          isSystem: true,
        },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      // Lost the race against another worker; the index guarantees the winner's
      // row is the one and only actor.
      if (isUniqueViolation(error)) {
        const winner = await tx.user.findFirstOrThrow({
          where: { isSystem: true },
          select: { id: true },
        });
        return winner.id;
      }
      throw error;
    }
  }
}
