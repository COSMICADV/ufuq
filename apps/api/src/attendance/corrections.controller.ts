/**
 * `/api/v1/attendance-corrections` — DOCUMENT 08 §4.5, every row of it.
 *
 * | Method | Endpoint                              | Permission                           |
 * | ------ | ------------------------------------- | ------------------------------------ |
 * | POST   | `/attendance-corrections`             | attendance.request_correction        |
 * | GET    | `/attendance-corrections`             | approve_correction **or** as requester |
 * | GET    | `/attendance-corrections/{id}`        | scope-checked                        |
 * | POST   | `/attendance-corrections/{id}/approve`| attendance.approve_correction        |
 * | POST   | `/attendance-corrections/{id}/reject` | attendance.approve_correction        |
 * | POST   | `/attendance-corrections/{id}/cancel` | own, pending only                    |
 *
 * The list and the detail carry no `@RequirePermission`: DOCUMENT 08 §4.5
 * makes them reachable *either* by an approver or by the requester, which is
 * one permission or the other and not a single one the guard could name. The
 * service resolves whichever the caller holds and refuses a caller with
 * neither — the check is not skipped, it is made where it can be made
 * correctly (DOCUMENT 27 RULE 9).
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
  ApproveCorrectionDto,
  CorrectionListQueryDto,
  CreateCorrectionDto,
  RejectCorrectionDto,
} from './dto/attendance.dto.js';
import type { CorrectionPayload } from './attendance-payload.js';
import { CorrectionsService } from './corrections.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('attendance-corrections')
export class CorrectionsController {
  constructor(@Inject(CorrectionsService) private readonly corrections: CorrectionsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('attendance.request_correction')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateCorrectionDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CorrectionPayload>> {
    return single(await this.corrections.create(ctx, dto, origin), { locale });
  }

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: CorrectionListQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<CorrectionPayload>> {
    const { items, total } = await this.corrections.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get(':id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CorrectionPayload>> {
    return single(await this.corrections.findOne(ctx, id), { locale });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('attendance.approve_correction')
  async approve(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: ApproveCorrectionDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CorrectionPayload>> {
    return single(await this.corrections.approve(ctx, id, dto, origin), { locale });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('attendance.approve_correction')
  async reject(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: RejectCorrectionDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CorrectionPayload>> {
    return single(await this.corrections.reject(ctx, id, dto, origin), { locale });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('attendance.request_correction')
  async cancel(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CorrectionPayload>> {
    return single(await this.corrections.cancel(ctx, id, origin), { locale });
  }
}
