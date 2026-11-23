/**
 * Business Identity — one row per company (created on first save). Everyone
 * in the company may read it (it is what their receipts, menus and documents
 * show); only `settings.update` changes it. Logo bytes sit in the private
 * bucket under the company's own prefix and are streamed by this service to
 * members of that company only — row-level security finds the key, so another
 * company's request never reaches it.
 */

import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { BusinessIdentity, PrismaClient, TenantClient } from '@ufuq/db';
import type { Readable } from 'node:stream';

import { OBJECT_STORAGE } from '../attachments/object-storage.js';
import type { ObjectStorage } from '../attachments/object-storage.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { fieldError, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import type { UpdateIdentityDto } from './identity.dto.js';
import { CONTENT_TYPES, inspectLogo, normaliseColor, thermalProblem } from './identity-rules.js';
import type { LogoType } from './identity-rules.js';

/** Activities whose admin is walked through the identity step after first sign-in. */
export const ONBOARDING_ACTIVITIES: readonly string[] = ['food'];

export interface IdentityPayload {
  readonly company_name: string;
  readonly activity: string | null;
  readonly name_ar: string | null;
  readonly name_en: string | null;
  readonly primary_color: string | null;
  readonly secondary_color: string | null;
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly address_ar: string | null;
  readonly address_en: string | null;
  readonly instagram: string | null;
  readonly facebook: string | null;
  readonly tiktok: string | null;
  readonly logo: {
    readonly type: LogoType;
    readonly width: number | null;
    readonly height: number | null;
    readonly version: number;
    readonly has_thermal: boolean;
  } | null;
  /** Receipts print the logo (when a thermal copy exists); otherwise the name as text. */
  readonly print_logo: boolean;
  readonly can_edit: boolean;
  readonly onboarding: { readonly applies: boolean; readonly pending: boolean };
  readonly updated_at: string | null;
}

export interface UploadedPart {
  readonly buffer: Buffer;
  readonly size: number;
}

export interface LogoStream {
  readonly stream: Readable;
  readonly contentType: string;
}

const TEXT_FIELDS = [
  ['name_ar', 'nameAr'],
  ['name_en', 'nameEn'],
  ['phone', 'phone'],
  ['whatsapp', 'whatsapp'],
  ['email', 'email'],
  ['website', 'website'],
  ['address_ar', 'addressAr'],
  ['address_en', 'addressEn'],
  ['instagram', 'instagram'],
  ['facebook', 'facebook'],
  ['tiktok', 'tiktok'],
] as const;

function forbidden(): AppException {
  return new AppException(ERROR_CODES.FORBIDDEN, 403);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

@Injectable()
export class IdentityService extends TenantScopedService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    super(prisma, audit);
  }

  get(ctx: AuthContext): Promise<IdentityPayload> {
    return this.tenant(ctx, async (tx) => this.payload(tx, ctx, await this.row(tx, ctx)));
  }

  update(ctx: AuthContext, dto: UpdateIdentityDto, origin: RequestOrigin): Promise<IdentityPayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await this.editable(tx, ctx);
      const data: Record<string, string | boolean | null> = {};
      const changed: string[] = [];
      for (const [field, column] of TEXT_FIELDS) {
        const value = dto[field];
        if (value === undefined) continue;
        data[column] = value === null || value === '' ? null : value;
        changed.push(field);
      }
      for (const [field, column] of [['primary_color', 'primaryColor'], ['secondary_color', 'secondaryColor']] as const) {
        const value = dto[field];
        if (value === undefined) continue;
        data[column] = value === null ? null : normaliseColor(value);
        changed.push(field);
      }
      if (dto.print_logo !== undefined) {
        data.printLogo = dto.print_logo;
        changed.push('print_logo');
      }
      if (changed.length === 0) return this.payload(tx, ctx, before);
      const row = await tx.businessIdentity.upsert({
        where: { companyId: ctx.companyId },
        create: { companyId: ctx.companyId, ...data, updatedBy: ctx.userId },
        update: { ...data, updatedBy: ctx.userId },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'BUSINESS_IDENTITY_UPDATED',
        entityType: 'business_identity',
        entityId: ctx.companyId,
        newValues: { fields: changed },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.payload(tx, ctx, row);
    });
  }

  async uploadLogo(
    ctx: AuthContext,
    logo: UploadedPart | undefined,
    thermal: UploadedPart | undefined,
    printLogo: boolean | undefined,
    origin: RequestOrigin,
  ): Promise<IdentityPayload> {
    if (!logo) throw fieldError({ logo: ['required'] });
    const inspected = inspectLogo(logo.buffer);
    if (typeof inspected === 'string') throw fieldError({ logo: [inspected === 'too_large' ? 'too_large' : 'invalid'] });
    if (thermal) {
      const problem = thermalProblem(thermal.buffer);
      if (problem) throw fieldError({ thermal: [problem === 'too_large' ? 'too_large' : 'invalid'] });
    }
    // Permission first, before anything is written to storage.
    await this.tenant(ctx, async (tx) => {
      await this.editable(tx, ctx);
    });
    const prefix = `companies/${ctx.companyId}/brand`;
    const ext = inspected.type === 'jpeg' ? 'jpg' : inspected.type;
    const logoKey = `${prefix}/${generateId()}.${ext}`;
    const thermalKey = thermal ? `${prefix}/${generateId()}-thermal.png` : null;
    await this.storage.put({ key: logoKey, body: logo.buffer, contentType: CONTENT_TYPES[inspected.type], checksum: sha256(logo.buffer) });
    if (thermal && thermalKey) {
      await this.storage.put({ key: thermalKey, body: thermal.buffer, contentType: 'image/png', checksum: sha256(thermal.buffer) });
    }
    let replaced: readonly (string | null)[] = [];
    try {
      const result = await this.tenant(ctx, async (tx) => {
        const before = await this.editable(tx, ctx);
        replaced = [before?.logoKey ?? null, before?.thermalKey ?? null];
        const fields = {
          logoKey,
          logoType: inspected.type,
          logoWidth: inspected.width,
          logoHeight: inspected.height,
          thermalKey,
          printLogo: thermalKey === null ? false : (printLogo ?? true),
          updatedBy: ctx.userId,
        };
        const row = await tx.businessIdentity.upsert({
          where: { companyId: ctx.companyId },
          create: { companyId: ctx.companyId, ...fields, logoVersion: 1 },
          update: { ...fields, logoVersion: { increment: 1 } },
        });
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'BUSINESS_IDENTITY_LOGO_CHANGED',
          entityType: 'business_identity',
          entityId: ctx.companyId,
          newValues: { type: inspected.type, width: inspected.width, height: inspected.height, thermal: thermalKey !== null },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
        return this.payload(tx, ctx, row);
      });
      await this.discard(replaced);
      return result;
    } catch (error) {
      await this.discard([logoKey, thermalKey]);
      throw error;
    }
  }

  removeLogo(ctx: AuthContext, origin: RequestOrigin): Promise<IdentityPayload> {
    let replaced: readonly (string | null)[] = [];
    return this.tenant(ctx, async (tx) => {
      const before = await this.editable(tx, ctx);
      if (!before?.logoKey) return this.payload(tx, ctx, before);
      replaced = [before.logoKey, before.thermalKey];
      const row = await tx.businessIdentity.update({
        where: { companyId: ctx.companyId },
        data: { logoKey: null, logoType: null, logoWidth: null, logoHeight: null, thermalKey: null, logoVersion: { increment: 1 }, updatedBy: ctx.userId },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'BUSINESS_IDENTITY_LOGO_CHANGED',
        entityType: 'business_identity',
        entityId: ctx.companyId,
        newValues: { removed: true },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return this.payload(tx, ctx, row);
    }).then(async (result) => {
      await this.discard(replaced);
      return result;
    });
  }

  async logo(ctx: AuthContext, variant: 'main' | 'thermal'): Promise<LogoStream> {
    const row = await this.tenant(ctx, async (tx) => {
      await this.businessCompany(tx, ctx);
      return tx.businessIdentity.findUnique({ where: { companyId: ctx.companyId } });
    });
    const key = variant === 'thermal' ? row?.thermalKey : row?.logoKey;
    if (!row || !key) throw notFound();
    // The key always sits under this company's own prefix; anything else is refused.
    if (!key.startsWith(`companies/${ctx.companyId}/brand/`)) throw notFound();
    const type: LogoType = variant === 'thermal' ? 'png' : (row.logoType as LogoType);
    return { stream: await this.storage.get(key), contentType: CONTENT_TYPES[type] };
  }

  onboarding(ctx: AuthContext, action: 'complete' | 'skip'): Promise<IdentityPayload> {
    return this.tenant(ctx, async (tx) => {
      await this.editable(tx, ctx);
      const now = new Date();
      const data = action === 'complete' ? { onboardedAt: now } : { onboardingSkippedAt: now };
      const row = await tx.businessIdentity.upsert({
        where: { companyId: ctx.companyId },
        create: { companyId: ctx.companyId, ...data, updatedBy: ctx.userId },
        update: data,
      });
      return this.payload(tx, ctx, row);
    });
  }

  // -------------------------------------------------------------------------

  private async businessCompany(tx: TenantClient, ctx: AuthContext): Promise<{ name: string; businessActivity: string | null }> {
    const company = await tx.company.findUnique({
      where: { id: ctx.companyId },
      select: { name: true, businessActivity: true, kind: true },
    });
    if (!company || company.kind !== 'business') throw notFound();
    return company;
  }

  private async row(tx: TenantClient, ctx: AuthContext): Promise<BusinessIdentity | null> {
    await this.businessCompany(tx, ctx);
    return tx.businessIdentity.findUnique({ where: { companyId: ctx.companyId } });
  }

  private async editable(tx: TenantClient, ctx: AuthContext): Promise<BusinessIdentity | null> {
    const row = await this.row(tx, ctx);
    if (!ctx.permissions.has('settings.update')) throw forbidden();
    return row;
  }

  private async payload(tx: TenantClient, ctx: AuthContext, row: BusinessIdentity | null): Promise<IdentityPayload> {
    const company = await this.businessCompany(tx, ctx);
    const canEdit = ctx.permissions.has('settings.update');
    const applies = ONBOARDING_ACTIVITIES.includes(company.businessActivity ?? '');
    return {
      company_name: company.name,
      activity: company.businessActivity,
      name_ar: row?.nameAr ?? null,
      name_en: row?.nameEn ?? null,
      primary_color: row?.primaryColor ?? null,
      secondary_color: row?.secondaryColor ?? null,
      phone: row?.phone ?? null,
      whatsapp: row?.whatsapp ?? null,
      email: row?.email ?? null,
      website: row?.website ?? null,
      address_ar: row?.addressAr ?? null,
      address_en: row?.addressEn ?? null,
      instagram: row?.instagram ?? null,
      facebook: row?.facebook ?? null,
      tiktok: row?.tiktok ?? null,
      logo:
        row?.logoKey && row.logoType
          ? {
              type: row.logoType as LogoType,
              width: row.logoWidth,
              height: row.logoHeight,
              version: row.logoVersion,
              has_thermal: row.thermalKey !== null,
            }
          : null,
      print_logo: row ? row.printLogo && row.thermalKey !== null : false,
      can_edit: canEdit,
      onboarding: {
        applies,
        pending: applies && canEdit && !row?.onboardedAt && !row?.onboardingSkippedAt,
      },
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** Best effort: an orphaned object costs storage, never correctness. */
  private async discard(keys: readonly (string | null)[]): Promise<void> {
    for (const key of keys) {
      if (!key) continue;
      try {
        await this.storage.delete(key);
      } catch (error) {
        this.logger.warn(`Could not delete replaced logo object: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}
