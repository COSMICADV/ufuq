/**
 * Company notification preferences — DOCUMENT 19 rule 10 ("per-event channel
 * preferences live in company settings; per-user preferences are future
 * work"), DOCUMENT 04 B25 ("Notifications — per-event channel toggles").
 *
 * One switch per notification type and channel. V1 has one channel, so the
 * settings are one switch per type: a company may stop a type it finds
 * noisy. A type with no row is on. Every change is audited
 * `settings.notification_changed` (DOCUMENT 21) with each switch's old and
 * new value. Adding email or push later adds a channel to the list; nothing
 * here changes shape.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { NotificationType, PrismaClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import { TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import { NOTIFICATION_TYPES, V1_CHANNELS } from './notification-catalogue.js';
import type { NotificationAudience, V1Channel } from './notification-catalogue.js';
import type { UpdateNotificationSettingsDto } from './dto/notifications.dto.js';

export interface NotificationSettingPayload {
  readonly type: NotificationType;
  readonly audience: NotificationAudience;
  readonly priority: string;
  readonly channels: readonly { readonly channel: V1Channel; readonly enabled: boolean }[];
}

@Injectable()
export class NotificationSettingsService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  async list(ctx: AuthContext): Promise<NotificationSettingPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const rows = await tx.companyNotificationSetting.findMany({
        select: { type: true, channel: true, enabled: true },
      });
      return this.payload(rows);
    });
  }

  async update(
    ctx: AuthContext,
    dto: UpdateNotificationSettingsDto,
    origin: RequestOrigin,
  ): Promise<NotificationSettingPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const current = await tx.companyNotificationSetting.findMany({
        select: { type: true, channel: true, enabled: true },
      });
      const enabledNow = (type: string, channel: string): boolean =>
        current.find((row) => row.type === type && row.channel === channel)?.enabled ?? true;

      const oldValues: Record<string, boolean> = {};
      const newValues: Record<string, boolean> = {};
      for (const preference of dto.preferences) {
        const before = enabledNow(preference.type, preference.channel);
        if (before === preference.enabled) continue;
        const key = `${preference.type}.${preference.channel}`;
        oldValues[key] = before;
        newValues[key] = preference.enabled;
        await tx.companyNotificationSetting.upsert({
          where: {
            companyId_type_channel: {
              companyId: ctx.companyId,
              type: preference.type,
              channel: preference.channel,
            },
          },
          create: {
            companyId: ctx.companyId,
            type: preference.type,
            channel: preference.channel,
            enabled: preference.enabled,
            updatedBy: ctx.userId,
          },
          update: { enabled: preference.enabled, updatedBy: ctx.userId },
        });
      }
      if (Object.keys(newValues).length > 0) {
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'SETTINGS_NOTIFICATION_CHANGED',
          entityType: 'company',
          entityId: ctx.companyId,
          oldValues,
          newValues,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      const rows = await tx.companyNotificationSetting.findMany({
        select: { type: true, channel: true, enabled: true },
      });
      return this.payload(rows);
    });
  }

  private payload(
    rows: readonly { readonly type: string; readonly channel: string; readonly enabled: boolean }[],
  ): NotificationSettingPayload[] {
    return NOTIFICATION_TYPES.map((definition) => ({
      type: definition.type,
      audience: definition.audience,
      priority: definition.priority,
      channels: V1_CHANNELS.map((channel) => ({
        channel,
        enabled:
          rows.find((row) => row.type === definition.type && row.channel === channel)?.enabled ??
          true,
      })),
    }));
  }
}
