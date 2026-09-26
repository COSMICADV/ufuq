/**
 * `GET /company`, `PATCH /company` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.1.
 *
 * The company being read is always the caller's own: its id comes from the
 * session (DOCUMENT 08 §1's critical rule), and row-level security would
 * refuse any other one even if the id came from somewhere else.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Company, Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AuditService } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';

import type { UpdateCompanyDto } from './dto/company.dto.js';
import { companyPayload } from './payloads.js';
import type { CompanyPayload } from './payloads.js';
import { notFound, TenantScopedService } from './tenant-scoped.service.js';

/**
 * The company columns Phase 4 may write, by approved decision: name, logo,
 * timezone, currency, locale, fiscal-month start day. Declaring the set here
 * rather than spreading the DTO means adding a field to the DTO cannot, on its
 * own, make a new column writable.
 */
const EDITABLE_FIELDS = [
  'name',
  'logo_path',
  'timezone',
  'currency',
  'default_locale',
  'fiscal_month_start_day',
  // DOCUMENT 12 rule 13 — the correction window is a company policy, so it is
  // configured where the company's other policies are.
  'correction_window_days',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

const COLUMN_BY_FIELD = {
  name: 'name',
  logo_path: 'logoPath',
  timezone: 'timezone',
  currency: 'currency',
  default_locale: 'defaultLocale',
  fiscal_month_start_day: 'fiscalMonthStartDay',
  correction_window_days: 'correctionWindowDays',
} as const satisfies Record<EditableField, keyof Company>;

@Injectable()
export class CompanyService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    super(prisma);
  }

  async get(ctx: AuthContext): Promise<CompanyPayload> {
    return this.tenant(ctx, async (tx) => companyPayload(await this.load(tx, ctx)));
  }

  /**
   * DOCUMENT 21 `settings.company_updated`, with `old_values`/`new_values`
   * restricted to the fields that actually changed (DOCUMENT 21 "Record
   * content"). A request that changes nothing writes no audit record: there
   * are no changed fields to store, and a trail full of empty entries is a
   * trail nobody reads.
   */
  async update(
    ctx: AuthContext,
    dto: UpdateCompanyDto,
    origin: RequestOrigin,
  ): Promise<CompanyPayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await this.load(tx, ctx);

      const data: Prisma.CompanyUpdateInput = {};
      const oldValues: Record<string, unknown> = {};
      const newValues: Record<string, unknown> = {};

      for (const field of EDITABLE_FIELDS) {
        const submitted = dto[field];
        if (submitted === undefined) {
          continue;
        }
        const column = COLUMN_BY_FIELD[field];
        // Currency is stored uppercase so `egp` and `EGP` are one value and
        // the CHAR(3) column never holds two spellings of one currency.
        const value = field === 'currency' ? (submitted as string).toUpperCase() : submitted;
        if (before[column] === value) {
          continue;
        }
        Object.assign(data, { [column]: value });
        oldValues[field] = before[column];
        newValues[field] = value;
      }

      if (Object.keys(data).length === 0) {
        return companyPayload(before);
      }

      const after = await tx.company.update({ where: { id: ctx.companyId }, data });

      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SETTINGS_COMPANY_UPDATED',
        entityType: 'company',
        entityId: after.id,
        oldValues: oldValues as Prisma.InputJsonObject,
        newValues: newValues as Prisma.InputJsonObject,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return companyPayload(after);
    });
  }

  private async load(tx: TenantClient, ctx: AuthContext): Promise<Company> {
    const company = await tx.company.findFirst({
      where: { id: ctx.companyId, deletedAt: null },
    });
    if (!company) {
      throw notFound();
    }
    return company;
  }
}
