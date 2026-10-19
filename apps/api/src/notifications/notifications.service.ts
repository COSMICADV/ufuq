/**
 * The notification centre's reads and writes — DOCUMENT 08 §4.13, DOCUMENT
 * 19 "Permissions", rule 6.
 *
 * **Users see only their own notifications.** Every query here is
 * `user_id = caller`, inside the caller's tenant transaction (row-level
 * security confines it to the company besides). There is no parameter that
 * names another user, so there is no endpoint that lists another user's
 * feed. Someone else's notification id is **404**, the same answer as an id
 * that does not exist: the response does not reveal that it exists.
 *
 * The feed is newest first, paged and bounded (at most
 * {@link FEED_MAX_PAGE_SIZE} per page). A summary stands in for the rows it
 * absorbed (DOCUMENT 19 rule 4); they are never listed or counted on their
 * own. Each item says whether its source still exists, so a deleted record
 * renders as "no longer available" rather than a broken link (DOCUMENT 19
 * "Error states") — checked with one query per kind of source on the page,
 * never one per notification.
 */

import { Inject, Injectable } from '@nestjs/common';
import { withTenant } from '@ufuq/db';
import type { Notification, PrismaClient, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';

import { FEED_DEFAULT_PAGE_SIZE, FEED_MAX_PAGE_SIZE } from './notification-catalogue.js';
import type { NotificationAudience, RelatedType } from './notification-catalogue.js';

export interface RelatedPayload {
  readonly type: RelatedType;
  /** Null for a summary, which links to the list of its type. */
  readonly id: string | null;
  readonly available: boolean;
  /** What a link needs beyond the id: the day of an attendance record, a report's month or key. */
  readonly meta: Readonly<Record<string, string>> | null;
}

export interface NotificationPayload {
  readonly id: string;
  readonly type: string;
  readonly priority: string;
  readonly audience: NotificationAudience;
  readonly title: { readonly ar: string; readonly en: string };
  readonly body: { readonly ar: string; readonly en: string };
  readonly related: RelatedPayload;
  readonly group_count: number;
  readonly is_summary: boolean;
  readonly read_at: string | null;
  readonly handled_at: string | null;
  readonly created_at: string;
}

export interface FeedQuery {
  readonly page?: number;
  readonly per_page?: number;
  readonly unread?: boolean;
}

function notFound(): AppException {
  return new AppException(ERROR_CODES.NOT_FOUND, 404);
}

type Availability = Map<string, Readonly<Record<string, string>> | null>;

@Injectable()
export class NotificationsService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  private tenant<T>(ctx: AuthContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, ctx.companyId, fn);
  }

  /** The caller's feed rows: their own, and not absorbed into a summary. */
  private feedWhere(ctx: AuthContext, unreadOnly = false) {
    return {
      userId: ctx.userId,
      groupedIntoId: null,
      ...(unreadOnly ? { readAt: null } : {}),
    };
  }

  async list(
    ctx: AuthContext,
    query: FeedQuery,
  ): Promise<{ items: NotificationPayload[]; total: number; page: number; perPage: number }> {
    const page = query.page ?? 1;
    const perPage = Math.min(query.per_page ?? FEED_DEFAULT_PAGE_SIZE, FEED_MAX_PAGE_SIZE);
    return this.tenant(ctx, async (tx) => {
      const where = this.feedWhere(ctx, query.unread === true);
      const rows = await tx.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * perPage,
        take: perPage,
      });
      const total = await tx.notification.count({ where });
      const available = await this.availability(tx, rows);
      return { items: rows.map((row) => this.payload(row, available)), total, page, perPage };
    });
  }

  async unreadCount(ctx: AuthContext): Promise<{ count: number }> {
    return this.tenant(ctx, async (tx) => ({
      count: await tx.notification.count({ where: this.feedWhere(ctx, true) }),
    }));
  }

  /** Marks one of the caller's notifications read (idempotent); a summary takes its rows with it. */
  async markRead(ctx: AuthContext, id: string, now = new Date()): Promise<NotificationPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.notification.findFirst({ where: { id, userId: ctx.userId } });
      if (row === null) throw notFound();
      if (row.readAt === null) {
        await tx.notification.updateMany({
          where: { userId: ctx.userId, readAt: null, OR: [{ id }, { groupedIntoId: id }] },
          data: { readAt: now },
        });
      }
      const updated = await tx.notification.findFirstOrThrow({ where: { id, userId: ctx.userId } });
      return this.payload(updated, await this.availability(tx, [updated]));
    });
  }

  /** DOCUMENT 19 rule 6 — the caller's own unread notifications, all of them. */
  async markAllRead(ctx: AuthContext, now = new Date()): Promise<{ updated: number }> {
    return this.tenant(ctx, async (tx) => {
      const { count } = await tx.notification.updateMany({
        where: { userId: ctx.userId, readAt: null },
        data: { readAt: now },
      });
      return { updated: count };
    });
  }

  // -- Payload -----------------------------------------------------------------

  private payload(row: Notification, available: Availability): NotificationPayload {
    const isSummary = row.relatedId === null;
    const key = `${row.relatedType}:${row.relatedId ?? ''}`;
    return {
      id: row.id,
      type: row.type,
      priority: row.priority,
      audience: row.audience as NotificationAudience,
      title: { ar: row.titleAr, en: row.titleEn },
      body: { ar: row.bodyAr, en: row.bodyEn },
      related: {
        type: row.relatedType as RelatedType,
        id: row.relatedId,
        available: isSummary || available.has(key),
        meta: isSummary ? null : (available.get(key) ?? null),
      },
      group_count: row.groupCount,
      is_summary: isSummary,
      read_at: row.readAt?.toISOString() ?? null,
      handled_at: row.handledAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    };
  }

  /**
   * Which of these notifications' sources still exist (not deleted), keyed
   * `type:id`, with the little a link needs. One query per kind of source.
   */
  private async availability(
    tx: TenantClient,
    rows: readonly Notification[],
  ): Promise<Availability> {
    const ids = new Map<string, string[]>();
    for (const row of rows) {
      if (row.relatedId === null) continue;
      const list = ids.get(row.relatedType) ?? [];
      list.push(row.relatedId);
      ids.set(row.relatedType, list);
    }
    const found: Availability = new Map();
    const mark = (type: string, id: string, meta: Record<string, string> | null = null) =>
      found.set(`${type}:${id}`, meta);

    for (const [type, list] of ids) {
      const inList = { in: [...new Set(list)] };
      switch (type as RelatedType) {
        case 'request':
          for (const row of await tx.request.findMany({
            where: { id: inList },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'task':
          for (const row of await tx.task.findMany({
            where: { id: inList, deletedAt: null },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'goal':
          for (const row of await tx.goal.findMany({
            where: { id: inList, deletedAt: null },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'product':
          for (const row of await tx.product.findMany({
            where: { id: inList, deletedAt: null },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'payroll_period':
          for (const row of await tx.payrollPeriod.findMany({
            where: { id: inList },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'attendance_record':
          for (const row of await tx.attendanceRecord.findMany({
            where: { id: inList },
            select: { id: true, date: true, employeeId: true },
          }))
            mark(type, row.id, {
              date: row.date.toISOString().slice(0, 10),
              employee_id: row.employeeId,
            });
          break;
        case 'employee':
          for (const row of await tx.employee.findMany({
            where: { id: inList, deletedAt: null },
            select: { id: true },
          }))
            mark(type, row.id);
          break;
        case 'monthly_report':
          for (const row of await tx.monthlyEmployeeReport.findMany({
            where: { id: inList },
            select: { id: true, year: true, month: true, employeeId: true },
          }))
            mark(type, row.id, {
              month: `${String(row.year)}-${String(row.month).padStart(2, '0')}`,
              employee_id: row.employeeId,
            });
          break;
        case 'report_export':
          for (const row of await tx.reportExport.findMany({
            where: { id: inList },
            select: { id: true, reportKey: true },
          }))
            mark(type, row.id, { report_key: row.reportKey });
          break;
      }
    }
    return found;
  }
}
