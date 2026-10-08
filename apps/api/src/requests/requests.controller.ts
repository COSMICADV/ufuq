/**
 * `/api/v1/requests` — DOCUMENT 08 §4.9, every row of it.
 *
 * | Method | Endpoint                    | Permission                 |
 * | ------ | --------------------------- | -------------------------- |
 * | GET    | `/requests`                 | request.view (or own); `reviewable=true` needs request.review |
 * | POST   | `/requests`                 | request.create             |
 * | GET    | `/requests/pending-count`   | request.view (or own)      |
 * | GET    | `/requests/{id}`            | scope-checked              |
 * | POST   | `/requests/{id}/approve`    | request.review             |
 * | POST   | `/requests/{id}/reject`     | request.review · reason    |
 * | POST   | `/requests/{id}/cancel`     | request.cancel · own, pending |
 *
 * The reading endpoints carry no `@RequirePermission`, as for attendance
 * corrections: they are reachable through `request.view` **or** as the
 * requester (a manager's `team` scope does not include their own requests).
 * The service resolves that and refuses a caller with neither — the check is
 * made where it can be made correctly (DOCUMENT 27 RULE 9).
 *
 * `pending-count` is declared before `:id` so the literal path wins.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
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
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  ApproveRequestDto,
  CreateRequestDto,
  ListRequestsQueryDto,
  RejectRequestDto,
} from './dto/request.dto.js';
import type { RequestDetailPayload, RequestPayload } from './request-payload.js';
import { RequestsService } from './requests.service.js';
import type { PendingCount } from './requests.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('requests')
export class RequestsController {
  constructor(@Inject(RequestsService) private readonly requests: RequestsService) {}

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListRequestsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<RequestPayload>> {
    const { items, total } = await this.requests.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('request.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateRequestDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RequestDetailPayload>> {
    return single(await this.requests.create(ctx, dto, origin), { locale });
  }

  @Get('pending-count')
  async pendingCount(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PendingCount>> {
    return single(await this.requests.pendingCount(ctx), { locale });
  }

  @Get(':id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RequestDetailPayload>> {
    return single(await this.requests.findOne(ctx, id), { locale });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('request.review')
  async approve(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: ApproveRequestDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RequestDetailPayload>> {
    return single(await this.requests.approve(ctx, id, dto, origin), { locale });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('request.review')
  async reject(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: RejectRequestDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RequestDetailPayload>> {
    return single(await this.requests.reject(ctx, id, dto, origin), { locale });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('request.cancel')
  async cancel(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RequestDetailPayload>> {
    return single(await this.requests.cancel(ctx, id, origin), { locale });
  }
}
