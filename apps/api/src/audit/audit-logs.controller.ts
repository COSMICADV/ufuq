/**
 * `/api/v1/audit-logs` — DOCUMENT 08 §4.16, DOCUMENT 21 "API requirements".
 *
 * | Method | Endpoint                         | Permission |
 * | ------ | -------------------------------- | ---------- |
 * | GET    | `/audit-logs`                    | audit.view |
 * | GET    | `/audit-logs/entity/{type}/{id}` | audit.view |
 *
 * "No POST, PATCH, or DELETE endpoints exist for this resource." None is
 * declared here, so any such request is answered 404 by the router before any
 * code of ours runs.
 */

import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection } from '../common/envelope.js';
import type { CollectionResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';
import { fieldError } from '../company-structure/tenant-scoped.service.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  ENTITY_TYPE_PATTERN,
  EntityHistoryQueryDto,
  ListAuditLogsQueryDto,
} from './dto/audit-log.dto.js';
import type { AuditLogPayload } from './audit-log-payload.js';
import { AuditLogsService } from './audit-logs.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('audit-logs')
export class AuditLogsController {
  constructor(@Inject(AuditLogsService) private readonly audit: AuditLogsService) {}

  @Get()
  @RequirePermission('audit.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListAuditLogsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<AuditLogPayload>> {
    const { items, total } = await this.audit.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get('entity/:type/:id')
  @RequirePermission('audit.view')
  async entityHistory(
    @CurrentUser() ctx: AuthContext,
    @Param('type') type: string,
    @Param('id', uuidParam) id: string,
    @Query() query: EntityHistoryQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<AuditLogPayload>> {
    if (!ENTITY_TYPE_PATTERN.test(type)) {
      throw fieldError({ type: ['invalid'] });
    }
    const { items, total } = await this.audit.entityHistory(ctx, type, id, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}
