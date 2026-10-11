/**
 * The audit read surface — DOCUMENT 21 "API requirements", DOCUMENT 08 §4.16.
 *
 * **Read-only by construction.** This service has no write method, the
 * controller has no write route, and the database already refuses UPDATE and
 * DELETE on `audit_logs` to `ufuq_app` (Phase 3 migration). Writes happen only
 * through `AuditService.record`: either inside the transaction of the change
 * they describe, or after it commits through `AuditDispatcher`.
 *
 * **Tenant-scoped** the same way as everything else: every query runs inside
 * `withTenant`, so row-level security keeps `audit.view` from ever crossing
 * companies (DOCUMENT 21 rule 7). No query here names a company id.
 *
 * `audit.view` is company-scoped for ADMIN and held by no other role
 * (DOCUMENT 02), so there is no self/team narrowing to apply — the guard's
 * permission check is the whole authorization.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import type { ResolvedPage } from '../company-structure/dto/pagination.dto.js';
import { fieldError, TenantScopedService } from '../company-structure/tenant-scoped.service.js';
import { compareDates, instantAt, parseCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';

import { actionFromWire } from './audit-actions.js';
import { AUDIT_LOG_INCLUDE, auditLogPayload } from './audit-log-payload.js';
import type { AuditLogPayload } from './audit-log-payload.js';
import type { EntityHistoryQueryDto, ListAuditLogsQueryDto } from './dto/audit-log.dto.js';

export interface AuditLogList {
  readonly items: readonly AuditLogPayload[];
  readonly total: number;
}

/** Newest first; `id` breaks ties so two rows in the same millisecond cannot swap pages. */
const ORDER: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];

function nextDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

@Injectable()
export class AuditLogsService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  async list(ctx: AuthContext, query: ListAuditLogsQueryDto): Promise<AuditLogList> {
    const from = query.from === undefined ? null : parseCalendarDate(query.from);
    const to = query.to === undefined ? null : parseCalendarDate(query.to);
    if (from !== null && to !== null && compareDates(to, from) < 0) {
      throw fieldError({ to: ['end_before_start'] });
    }

    return this.tenant(ctx, async (tx) => {
      const and: Prisma.AuditLogWhereInput[] = [];
      if (query.user_id !== undefined) and.push({ userId: query.user_id });
      if (query.entity_type !== undefined) and.push({ entityType: query.entity_type });
      if (query.entity_id !== undefined) and.push({ entityId: query.entity_id });
      if (query.action !== undefined) and.push({ action: actionFromWire(query.action) });
      if (from !== null || to !== null) {
        const { timezone } = await tx.company.findFirstOrThrow({ select: { timezone: true } });
        and.push({
          createdAt: {
            ...(from === null ? {} : { gte: instantAt(from, 0, timezone) }),
            // Exclusive start of the following day, so the whole of `to` is in.
            ...(to === null ? {} : { lt: instantAt(nextDay(to), 0, timezone) }),
          },
        });
      }
      return this.page(tx, ctx, { AND: and }, resolvePage(query));
    });
  }

  /** DOCUMENT 21 rule 5 — one record's history. */
  async entityHistory(
    ctx: AuthContext,
    entityType: string,
    entityId: string,
    query: EntityHistoryQueryDto,
  ): Promise<AuditLogList> {
    return this.tenant(ctx, (tx) =>
      this.page(tx, ctx, { entityType, entityId }, resolvePage(query)),
    );
  }

  private async page(
    tx: TenantClient,
    ctx: AuthContext,
    where: Prisma.AuditLogWhereInput,
    page: ResolvedPage,
  ): Promise<AuditLogList> {
    const [rows, total] = await Promise.all([
      tx.auditLog.findMany({
        where,
        include: AUDIT_LOG_INCLUDE,
        orderBy: ORDER,
        skip: page.skip,
        take: page.take,
      }),
      tx.auditLog.count({ where }),
    ]);
    // Company-wide salary visibility only: a `self` grant is about the caller's
    // own pay, not a licence to read everybody's in an audit trail.
    const salaryScope = ctx.permissions.get('employee.view_salary');
    const canViewSalary = salaryScope === 'company' || salaryScope === 'platform';
    return { items: rows.map((row) => auditLogPayload(row, { canViewSalary })), total };
  }
}
