import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import type { Locale } from '@ufuq/i18n';
import { generateId, lookupUsersByEmail } from '@ufuq/db';
import { APP_ENV } from '../app.tokens.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { PasswordService } from '../auth/password.service.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { InvitationService } from '../auth/invitation.service.js';
import { InvitationMailer } from '../mail/invitation-mailer.js';
import { MAIL_TRANSPORT } from '../mail/mail-transport.js';
import type { MailTransport } from '../mail/mail-transport.js';
import type { ContactDto, PublicSubmissionDto, RegisterDto } from './public.dto.js';
import { contactMessage } from './contact-message.js';

@Injectable()
export class PublicSiteService {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
    @Inject(InvitationMailer) private readonly mailer: InvitationMailer,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {}

  async throttle(kind: string, ip: string | null): Promise<void> {
    const limit = await this.limits.consume(`public:${kind}:ip:${ip ?? 'unknown'}`, 5, 3600);
    if (!limit.allowed)
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
  }

  async protect(dto: PublicSubmissionDto, origin?: string): Promise<void> {
    const elapsed = Date.now() - dto.started_at;
    if (
      (origin !== undefined && origin !== this.env.webOrigin) ||
      dto.website ||
      elapsed < 1500 ||
      elapsed > 86400000
    ) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422);
    }
  }

  async contact(dto: ContactDto): Promise<void> {
    const to = this.env.mail.contactTo;
    if (!to) throw new AppException(ERROR_CODES.CONTACT_DELIVERY_FAILED, 503);
    try {
      await this.mail.send(contactMessage(to, dto));
    } catch {
      throw new AppException(ERROR_CODES.CONTACT_DELIVERY_FAILED, 503);
    }
  }

  async register(dto: RegisterDto, locale: Locale): Promise<void> {
    const violations = this.passwords.checkPolicy(dto.password);
    if (violations.length)
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { password: violations.map((v) => v.code) },
      });
    const passwordHash = await this.passwords.hash(dto.password);
    // Bind a fresh, server-generated tenant before its first insert; no RLS bypass.
    // Serialize on email across registrations, including retries after SMTP failure.
    const companyId = generateId();
    const delivery = await this.audit.withTenant(companyId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dto.email}, 16))`;
      const existing = await lookupUsersByEmail(tx, dto.email);
      if (existing.length) return { existing: true as const, candidates: existing };
      const userId = generateId();
      const role = await tx.role.findFirstOrThrow({
        where: { key: 'admin', companyId: null, isSystem: true },
      });
      await tx.company.create({
        data: {
          id: companyId,
          name: dto.company_name,
          slug: `company-${companyId}`,
          timezone: 'Africa/Cairo',
          defaultLocale: locale,
          employeeCountRange: dto.employee_count_range,
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          companyId,
          email: dto.email,
          displayName: dto.admin_name,
          phone: dto.phone,
          roleId: role.id,
          passwordHash,
          status: 'invited',
          locale,
        },
      });
      await tx.company.update({ where: { id: companyId }, data: { createdBy: userId } });
      const issued = await this.invitations.issue(tx, { companyId, userId, invitedBy: userId });
      await this.audit.record(tx, {
        companyId,
        userId,
        action: 'INVITATION_SENT',
        entityType: 'user',
        entityId: userId,
      });
      return { existing: false as const, ...issued };
    });
    let token: string;
    let expiresAt: Date;
    if (delivery.existing) {
      // An unverified registration can retry SMTP with its original credentials.
      const candidate = delivery.candidates.length === 1 ? delivery.candidates[0] : undefined;
      if (
        !candidate ||
        candidate.status !== 'invited' ||
        !candidate.passwordHash ||
        !(await this.passwords.verify(candidate.passwordHash, dto.password))
      )
        throw new AppException(ERROR_CODES.CONFLICT, 409);
      const issued = await this.audit.withTenant(candidate.companyId, async (tx) => {
        const company = await tx.company.findUniqueOrThrow({ where: { id: candidate.companyId } });
        if (company.employeeCountRange === null || company.name !== dto.company_name)
          throw new AppException(ERROR_CODES.CONFLICT, 409);
        const next = await this.invitations.issue(tx, {
          companyId: candidate.companyId,
          userId: candidate.id,
          invitedBy: candidate.id,
        });
        await this.audit.record(tx, {
          companyId: candidate.companyId,
          userId: candidate.id,
          action: 'INVITATION_SENT',
          entityType: 'user',
          entityId: candidate.id,
        });
        return next;
      });
      token = issued.token;
      expiresAt = issued.expiresAt;
    } else {
      token = delivery.token;
      expiresAt = delivery.expiresAt;
    }
    try {
      await this.mailer.send({
        to: dto.email,
        locale,
        token,
        expiresAt,
        firstName: dto.admin_name,
        companyName: dto.company_name,
        timeZone: 'Africa/Cairo',
      });
    } catch {
      throw new AppException(ERROR_CODES.MAIL_DELIVERY_FAILED, 503);
    }
  }
}
