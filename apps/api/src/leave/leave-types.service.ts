/**
 * Leave types — DOCUMENT 06 §3.12, DOCUMENT 16 "Data", DOCUMENT 04 B25
 * ("Leave types: type name, default allowance, paid/unpaid, requires
 * attachment, carry-over rule"), DOCUMENT 08 §4.2 (`/leave-types`, amended in
 * Phase 10 with PATCH and DELETE so the documented settings screen can edit
 * and retire a type).
 *
 *   - **Configuration, not code.** Nothing in leave keys off a type's name;
 *     every behaviour reads these fields.
 *   - **No retroactive rewrite.** Changing `default_days_per_year` affects
 *     balances written from now on (a new year, a new joiner). Existing
 *     balances, requests and approved leave keep the figures they were
 *     decided with; an ADMIN changes a balance explicitly (PATCH
 *     /leave-balances/{id}). The settings screen warns about this before
 *     saving.
 *   - **Soft delete** (DOCUMENT 16 "Soft delete on leave types"): a retired
 *     type takes no new requests and grants no new balances; its history stays.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient } from '@ufuq/db';

import { AuditService } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type { CreateLeaveTypeDto, UpdateLeaveTypeDto } from './dto/leave.dto.js';
import { leaveTypePayload } from './leave-payload.js';
import type { LeaveTypePayload } from './leave-payload.js';
import { forbidden } from './leave-query.js';
import { days } from './leave-rules.js';

@Injectable()
export class LeaveTypesService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    super(prisma);
  }

  /**
   * DOCUMENT 08 §4.2 gives the list to `settings.view`. A person requesting
   * leave must also see the types to choose one (C9), so `leave.request`
   * reads the active ones; retired types are for settings only.
   */
  async list(ctx: AuthContext, includeRetired: boolean): Promise<readonly LeaveTypePayload[]> {
    const settings = ctx.permissions.has('settings.view');
    if (!settings && !ctx.permissions.has('leave.request')) {
      throw forbidden();
    }
    return this.tenant(ctx, async (tx) => {
      const rows = await tx.leaveType.findMany({
        where: includeRetired && settings ? {} : { deletedAt: null },
        orderBy: [
          { deletedAt: { sort: 'asc', nulls: 'first' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
      });
      return rows.map(leaveTypePayload);
    });
  }

  async create(
    ctx: AuthContext,
    dto: CreateLeaveTypeDto,
    origin: RequestOrigin,
  ): Promise<LeaveTypePayload> {
    const cap = this.capFor(dto.carry_over_policy, dto.carry_over_cap ?? null);
    return this.tenant(ctx, async (tx) => {
      const row = await tx.leaveType.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          nameAr: dto.name_ar,
          nameEn: dto.name_en,
          isPaid: dto.is_paid,
          defaultDaysPerYear: days(dto.default_days_per_year).toString(),
          requiresAttachment: dto.requires_attachment,
          allowsNegativeBalance: dto.allows_negative_balance,
          carryOverPolicy: dto.carry_over_policy,
          carryOverCap: cap,
        },
      });
      const payload = leaveTypePayload(row);
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'LEAVE_TYPE_CREATED',
        entityType: 'leave_type',
        entityId: row.id,
        newValues: { ...payload, id: undefined } as unknown as Prisma.InputJsonObject,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      return payload;
    });
  }

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateLeaveTypeDto,
    origin: RequestOrigin,
  ): Promise<LeaveTypePayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await tx.leaveType.findFirst({ where: { id, deletedAt: null } });
      if (before === null) {
        throw notFound();
      }
      const policy = dto.carry_over_policy ?? before.carryOverPolicy;
      const requestedCap =
        dto.carry_over_cap === undefined
          ? before.carryOverCap === null
            ? null
            : days(before.carryOverCap).toString()
          : dto.carry_over_cap;
      const cap = this.capFor(policy, policy === 'capped' ? requestedCap : null);
      const row = await tx.leaveType.update({
        where: { id },
        data: {
          ...(dto.name_ar === undefined ? {} : { nameAr: dto.name_ar }),
          ...(dto.name_en === undefined ? {} : { nameEn: dto.name_en }),
          ...(dto.is_paid === undefined ? {} : { isPaid: dto.is_paid }),
          ...(dto.default_days_per_year === undefined
            ? {}
            : { defaultDaysPerYear: days(dto.default_days_per_year).toString() }),
          ...(dto.requires_attachment === undefined
            ? {}
            : { requiresAttachment: dto.requires_attachment }),
          ...(dto.allows_negative_balance === undefined
            ? {}
            : { allowsNegativeBalance: dto.allows_negative_balance }),
          carryOverPolicy: policy,
          carryOverCap: cap,
        },
      });
      await this.recordChange(tx, ctx, id, leaveTypePayload(before), leaveTypePayload(row), origin);
      return leaveTypePayload(row);
    });
  }

  /** Soft delete — DOCUMENT 16 "Soft delete on leave types". Audited as `leave_type.updated`. */
  async retire(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<LeaveTypePayload> {
    return this.tenant(ctx, async (tx) => {
      const before = await tx.leaveType.findFirst({ where: { id, deletedAt: null } });
      if (before === null) {
        throw notFound();
      }
      const row = await tx.leaveType.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.recordChange(tx, ctx, id, leaveTypePayload(before), leaveTypePayload(row), origin);
      return leaveTypePayload(row);
    });
  }

  /** The cap exists exactly when the policy is `capped` (the table's own CHECK). */
  private capFor(policy: string, cap: string | null): string | null {
    if (policy === 'capped') {
      if (cap === null) throw fieldError({ carry_over_cap: ['required'] });
      return days(cap).toString();
    }
    return null;
  }

  private async recordChange(
    tx: Parameters<Parameters<LeaveTypesService['tenant']>[1]>[0],
    ctx: AuthContext,
    id: string,
    before: LeaveTypePayload,
    after: LeaveTypePayload,
    origin: RequestOrigin,
  ): Promise<void> {
    const changed = (Object.keys(after) as (keyof LeaveTypePayload)[]).filter(
      (key) => key !== 'id' && before[key] !== after[key],
    );
    if (changed.length === 0) return;
    await this.audit.record(tx, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'LEAVE_TYPE_UPDATED',
      entityType: 'leave_type',
      entityId: id,
      oldValues: Object.fromEntries(changed.map((key) => [key, before[key]])),
      newValues: Object.fromEntries(changed.map((key) => [key, after[key]])),
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
  }
}
