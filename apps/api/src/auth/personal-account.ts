import { generateId, lookupUsersByEmail } from '@ufuq/db';
import type { Locale } from '@ufuq/i18n';

import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import type { AuditDispatcher } from './audit-dispatcher.js';

/**
 * Creates a 1to1OS Personal account: a one-person workspace — a `personal`
 * company, active at once (no owner review), and its only user, active, with
 * the `personal` system role (no Business permissions). Used by the password
 * sign-up and by "Continue with Google", which passes no password hash.
 * The email is unique across every account: CONFLICT if it is taken.
 */
export async function createPersonalAccount(
  audit: AuditDispatcher,
  input: {
    readonly name: string;
    readonly email: string;
    readonly passwordHash: string | null;
    readonly locale: Locale;
  },
): Promise<{ readonly companyId: string; readonly userId: string }> {
  const companyId = generateId();
  const userId = generateId();
  await audit.withTenant(companyId, async (tx) => {
    // Serialize on email so two simultaneous sign-ups cannot both succeed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.email}, 16))`;
    const existing = await lookupUsersByEmail(tx, input.email);
    if (existing.length) throw new AppException(ERROR_CODES.CONFLICT, 409);
    const role = await tx.role.findFirstOrThrow({
      where: { key: 'personal', companyId: null, isSystem: true },
    });
    await tx.company.create({
      data: {
        id: companyId,
        name: input.name,
        slug: `personal-${companyId}`,
        timezone: 'Africa/Cairo',
        defaultLocale: input.locale,
        kind: 'personal',
        status: 'active',
      },
    });
    await tx.user.create({
      data: {
        id: userId,
        companyId,
        email: input.email,
        displayName: input.name,
        roleId: role.id,
        passwordHash: input.passwordHash,
        status: 'active',
        locale: input.locale,
        ...(input.passwordHash === null ? { emailVerifiedAt: new Date() } : {}),
      },
    });
    await tx.company.update({ where: { id: companyId }, data: { createdBy: userId } });
    await audit.record(tx, {
      companyId,
      userId,
      action: 'SIGNUP_PERSONAL',
      entityType: 'company',
      entityId: companyId,
    });
  });
  return { companyId, userId };
}
