/**
 * The platform owner's sign-up review: list public sign-ups across every
 * company, and approve or reject the pending ones.
 *
 * Listing crosses tenants, so it goes through the one SECURITY DEFINER
 * function made for it (`listSignupRequests`). A decision touches a single
 * company, so it runs inside that company's own tenant scope like any other
 * write, and is audited there — attributed to the company's system actor,
 * because the owner is not a user of the company.
 */

import { Inject, Injectable } from '@nestjs/common';
import { listSignupRequests, withPlatformContext } from '@ufuq/db';
import type { PrismaClient, SignupRequestRow } from '@ufuq/db';
import type { Locale } from '@ufuq/i18n';
import { isLocale } from '@ufuq/i18n';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { SystemActorService } from '../attendance/system-actor.service.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import { SignupMailer } from '../mail/signup-mailer.js';

export type SignupDecision = 'approve' | 'reject';

@Injectable()
export class OwnerService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
    @Inject(SignupMailer) private readonly mailer: SignupMailer,
  ) {}

  list(): Promise<readonly SignupRequestRow[]> {
    return withPlatformContext(this.prisma, (tx) => listSignupRequests(tx));
  }

  /** Approve or reject a pending sign-up. Anything not pending is a 409. */
  async decide(companyId: string, decision: SignupDecision): Promise<SignupRequestRow> {
    const outcome = await this.audit.withTenant(companyId, async (tx) => {
      const company = await tx.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, status: true, createdBy: true, defaultLocale: true },
      });
      if (company === null) throw new AppException(ERROR_CODES.NOT_FOUND, 404);
      if (company.status !== 'pending_approval') throw new AppException(ERROR_CODES.CONFLICT, 409);
      await tx.company.update({
        where: { id: companyId },
        data: { status: decision === 'approve' ? 'active' : 'rejected', reviewedAt: new Date() },
      });
      const admin = company.createdBy
        ? await tx.user.findUnique({
            where: { id: company.createdBy },
            select: { email: true, displayName: true, locale: true },
          })
        : null;
      await this.audit.record(tx, {
        companyId,
        userId: await this.systemActor.resolve(tx, companyId),
        action: decision === 'approve' ? 'SIGNUP_APPROVED' : 'SIGNUP_REJECTED',
        entityType: 'company',
        entityId: companyId,
      });
      return { company, admin };
    });
    if (decision === 'approve' && outcome.admin) {
      const locale = outcome.admin.locale?.trim() ?? outcome.company.defaultLocale.trim();
      await this.mailer.notifyApproved({
        to: outcome.admin.email,
        locale: (isLocale(locale) ? locale : 'en') as Locale,
        name: outcome.admin.displayName ?? outcome.admin.email,
        companyName: outcome.company.name,
      });
    }
    const rows = await this.list();
    const row = rows.find((r) => r.companyId === companyId);
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 404);
    return row;
  }
}
