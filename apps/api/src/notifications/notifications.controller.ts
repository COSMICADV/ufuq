/**
 * Notifications — DOCUMENT 08 §4.13, DOCUMENT 19 "API requirements" and
 * "Permissions"; company preferences — DOCUMENT 19 rule 10.
 *
 * The four notification endpoints need only an authenticated caller: they
 * read and change the caller's **own** notifications and nothing else (the
 * service scopes every query to the caller). There is no route that takes a
 * user id.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  NotificationFeedQueryDto,
  UpdateNotificationSettingsDto,
} from './dto/notifications.dto.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import type { NotificationSettingPayload } from './notification-settings.service.js';
import { NotificationsService } from './notifications.service.js';
import type { NotificationPayload } from './notifications.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: NotificationFeedQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<NotificationPayload>> {
    const { items, total, page, perPage } = await this.notifications.list(ctx, {
      ...(query.page === undefined ? {} : { page: query.page }),
      ...(query.per_page === undefined ? {} : { per_page: query.per_page }),
      unread: query.unread === 'true',
    });
    return collection(items, total, { page, perPage }, { locale });
  }

  @Get('unread-count')
  async unreadCount(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ count: number }>> {
    return single(await this.notifications.unreadCount(ctx), { locale });
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ updated: number }>> {
    return single(await this.notifications.markAllRead(ctx), { locale });
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<NotificationPayload>> {
    return single(await this.notifications.markRead(ctx, id), { locale });
  }
}

@Controller('settings/notifications')
export class NotificationSettingsController {
  constructor(
    @Inject(NotificationSettingsService) private readonly settings: NotificationSettingsService,
  ) {}

  @Get()
  @RequirePermission('settings.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<NotificationSettingPayload[]>> {
    return single(await this.settings.list(ctx), { locale });
  }

  @Patch()
  @RequirePermission('settings.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: UpdateNotificationSettingsDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<NotificationSettingPayload[]>> {
    return single(await this.settings.update(ctx, dto, origin), { locale });
  }
}
