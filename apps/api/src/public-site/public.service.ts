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
import { SignupMailer } from '../mail/signup-mailer.js';
import { MAIL_TRANSPORT } from '../mail/mail-transport.js';
import type { MailTransport } from '../mail/mail-transport.js';
import type {
  ContactDto,
  PublicSubmissionDto,
  RegisterDto,
  RegisterPersonalDto,
} from './public.dto.js';
import { contactMessage } from './contact-message.js';
import { createPersonalAccount } from '../auth/personal-account.js';

@Injectable()
export class PublicSiteService {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
    @Inject(SignupMailer) private readonly signups: SignupMailer,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {}

  /**
   * Per-IP hourly limits for the public forms. Contact and company requests
   * (reviewed by the owner) allow 5; Personal sign-up is instant and every
   * attempt counts, a typo included, so it allows 20.
   */
  async throttle(kind: string, ip: string | null): Promise<void> {
    const max = kind === 'register-personal' ? 20 : 5;
    const limit = await this.limits.consume(`public:${kind}:ip:${ip ?? 'unknown'}`, max, 3600);
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

  /**
   * Public sign-up. The company and its first ADMIN are saved straight away,
   * but the company starts as `pending_approval`: the ADMIN's password works
   * only once the platform owner approves it on the owner page (login answers
   * ACCOUNT_PENDING_APPROVAL until then). No email goes to the visitor — the
   * owner's approval stands in for the old activation link — and the owner is
   * emailed best-effort, so a mail outage never loses a sign-up.
   */
  async register(dto: RegisterDto, locale: Locale): Promise<void> {
    const violations = this.passwords.checkPolicy(dto.password);
    if (violations.length)
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { password: violations.map((v) => v.code) },
      });
    // A sub-type belongs to Medical only.
    if (dto.business_subtype !== undefined && dto.business_activity !== 'medical') {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 422, {
        fields: { business_subtype: ['invalid'] },
      });
    }
    const passwordHash = await this.passwords.hash(dto.password);
    // Bind a fresh, server-generated tenant before its first insert; no RLS bypass.
    // Serialize on email so two simultaneous sign-ups cannot both succeed.
    const companyId = generateId();
    const requestedAt = new Date();
    await this.audit.withTenant(companyId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dto.email}, 16))`;
      const existing = await lookupUsersByEmail(tx, dto.email);
      if (existing.length) throw new AppException(ERROR_CODES.CONFLICT, 409);
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
          businessActivity: dto.business_activity ?? null,
          businessSubtype: dto.business_subtype ?? null,
          status: 'pending_approval',
          createdAt: requestedAt,
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
          status: 'active',
          locale,
        },
      });
      await tx.company.update({ where: { id: companyId }, data: { createdBy: userId } });
      await this.audit.record(tx, {
        companyId,
        userId,
        action: 'SIGNUP_REQUESTED',
        entityType: 'company',
        entityId: companyId,
      });
    });
    await this.signups.notifyOwner({
      companyId,
      companyName: dto.company_name,
      adminName: dto.admin_name,
      adminEmail: dto.email,
      adminPhone: dto.phone,
      employeeCountRange: dto.employee_count_range,
      businessActivity: dto.business_activity ?? null,
      businessSubtype: dto.business_subtype ?? null,
      requestedAt,
    });
  }

  /**
   * 1to1OS Personal sign-up. A one-person workspace: a `personal` company,
   * active straight away (no owner review), and its only user, active, with
   * the `personal` system role — which holds no Business permission. The
   * email is unique across every account, as for Business sign-up.
   */
  async registerPersonal(dto: RegisterPersonalDto, locale: Locale): Promise<void> {
    const violations = this.passwords.checkPolicy(dto.password);
    if (violations.length)
      throw new AppException(ERROR_CODES.PASSWORD_POLICY_VIOLATION, 422, {
        fields: { password: violations.map((v) => v.code) },
      });
    const passwordHash = await this.passwords.hash(dto.password);
    await createPersonalAccount(this.audit, {
      name: dto.name,
      email: dto.email,
      passwordHash,
      locale,
    });
  }
}
