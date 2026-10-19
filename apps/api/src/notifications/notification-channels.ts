/**
 * Channel dispatch — DOCUMENT 19 "Architecture" and "Channels".
 *
 * A channel is a class that receives the notifications a committed event
 * produced, after recipients, self-suppression and the company's per-event
 * preferences have been applied. V1 has one: `in_app`, whose delivery *is*
 * storage. Email and push are future dispatchers — "a new dispatcher class,
 * not a rewrite": they implement {@link NotificationChannelDispatcher} and are
 * added to {@link NOTIFICATION_CHANNELS}. Such a channel must skip a recipient
 * who is no longer active (DOCUMENT 19: "Recipient deactivated — created but
 * not dispatched to external channels").
 *
 * **Grouping** (DOCUMENT 19 rule 4, and "Bulk operation") happens here,
 * per recipient and type, under a transaction-scoped advisory lock so two
 * concurrent events cannot both decide they are the fourth:
 *
 *   1. An open summary of that type (unread, active in the last hour) absorbs
 *      the new items: its count rises, its text is rewritten and it moves to
 *      the top of the feed.
 *   2. Otherwise, if the unread notifications of that type from the last hour
 *      plus the new ones are **more than three**, or one operation brought
 *      **several** at once (a bulk operation), one summary is created and the
 *      rows it stands for are attached to it and leave the feed.
 *   3. Otherwise each is stored as itself.
 *
 * The absorbed rows are kept, so each source's "handled" state and the
 * retention purge still apply to them; the feed and the unread count show
 * only the summary.
 */

import { Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { NotificationChannel, NotificationType, TenantClient } from '@ufuq/db';

import { definitionOf, GROUPING_THRESHOLD, GROUPING_WINDOW_MS } from './notification-catalogue.js';
import type { NotificationAudience } from './notification-catalogue.js';
import { summaryContentFor } from './notification-content.js';
import type { Draft } from './notification-rules.js';

/** A draft that survived suppression and preferences, tied to its source event. */
export interface Dispatchable extends Draft {
  readonly eventId: string;
}

export interface NotificationChannelDispatcher {
  readonly channel: NotificationChannel;
  dispatch(
    tx: TenantClient,
    companyId: string,
    items: readonly Dispatchable[],
    now: Date,
  ): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

interface GroupKey {
  readonly userId: string;
  readonly type: NotificationType;
  readonly audience: NotificationAudience;
}

function groupsOf(
  items: readonly Dispatchable[],
): Map<string, { key: GroupKey; items: Dispatchable[] }> {
  const groups = new Map<string, { key: GroupKey; items: Dispatchable[] }>();
  for (const item of items) {
    const id = `${item.userId}|${item.type}|${item.audience}`;
    const group = groups.get(id) ?? {
      key: { userId: item.userId, type: item.type, audience: item.audience },
      items: [],
    };
    group.items.push(item);
    groups.set(id, group);
  }
  return groups;
}

@Injectable()
export class InAppChannel implements NotificationChannelDispatcher {
  readonly channel = 'in_app' as const;

  async dispatch(
    tx: TenantClient,
    companyId: string,
    items: readonly Dispatchable[],
    now: Date,
  ): Promise<void> {
    for (const { key, items: group } of groupsOf(items).values()) {
      await this.deliver(tx, companyId, key, group, now);
    }
  }

  private async deliver(
    tx: TenantClient,
    companyId: string,
    key: GroupKey,
    items: readonly Dispatchable[],
    now: Date,
  ): Promise<void> {
    // One decision at a time per recipient and type.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`notifications:${key.userId}:${key.type}`}, 0))`;
    const since = new Date(now.getTime() - GROUPING_WINDOW_MS);
    const base = { userId: key.userId, type: key.type, audience: key.audience };

    const summary = await tx.notification.findFirst({
      where: {
        ...base,
        groupCount: { gt: 1 },
        groupedIntoId: null,
        readAt: null,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, groupCount: true },
    });
    if (summary !== null) {
      await this.insert(tx, companyId, items, now, summary.id);
      await this.rewrite(tx, summary.id, key.type, summary.groupCount + items.length, now);
      return;
    }

    const recent = await tx.notification.findMany({
      where: {
        ...base,
        groupCount: 1,
        groupedIntoId: null,
        readAt: null,
        createdAt: { gte: since },
      },
      select: { id: true },
    });
    const total = recent.length + items.length;
    // A bulk operation is one that concerns several records at once (two
    // milestones of the same goal are not a bulk operation).
    const bulk = new Set(items.map((item) => item.relatedId)).size > 1;
    if (total <= GROUPING_THRESHOLD && !bulk) {
      await this.insert(tx, companyId, items, now, null);
      return;
    }

    // More than three within the hour, or a bulk operation: one summary.
    const summaryId = generateId();
    const content = summaryContentFor(key.type, total);
    await tx.notification.create({
      data: {
        id: summaryId,
        companyId,
        userId: key.userId,
        type: key.type,
        priority: definitionOf(key.type).priority,
        audience: key.audience,
        channel: 'in_app',
        ...content,
        relatedType: definitionOf(key.type).relatedType,
        relatedId: null,
        eventId: items[items.length - 1]?.eventId ?? null,
        groupCount: total,
        createdAt: now,
        updatedAt: now,
      },
    });
    if (recent.length > 0) {
      await tx.notification.updateMany({
        where: { id: { in: recent.map((row) => row.id) } },
        data: { groupedIntoId: summaryId, updatedAt: now },
      });
    }
    await this.insert(tx, companyId, items, now, summaryId);
  }

  private async insert(
    tx: TenantClient,
    companyId: string,
    items: readonly Dispatchable[],
    now: Date,
    groupedIntoId: string | null,
  ): Promise<void> {
    await tx.notification.createMany({
      data: items.map((item) => ({
        id: generateId(),
        companyId,
        userId: item.userId,
        type: item.type,
        priority: definitionOf(item.type).priority,
        audience: item.audience,
        channel: 'in_app' as const,
        ...item.content,
        relatedType: item.relatedType,
        relatedId: item.relatedId,
        eventId: item.eventId,
        groupedIntoId,
        createdAt: now,
        updatedAt: now,
      })),
    });
  }

  private async rewrite(
    tx: TenantClient,
    summaryId: string,
    type: NotificationType,
    count: number,
    now: Date,
  ): Promise<void> {
    await tx.notification.update({
      where: { id: summaryId },
      data: {
        ...summaryContentFor(type, count),
        groupCount: count,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
}
