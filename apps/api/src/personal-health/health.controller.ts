import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { CreateDocumentDto, ListDocumentsQueryDto, UpdateDocumentDto } from './health.dto.js';
import { PersonalHealthService } from './health.service.js';
import type { DocumentPayload, OverviewPayload } from './health.service.js';

const uuid = new ParseUUIDPipe();

/**
 * 1to1OS Personal — Health. Every route needs `personal.health`, held only by
 * the `personal` role; row-level security keeps each account to its own rows.
 */
@Controller('personal/health')
@RequirePermission('personal.health')
export class PersonalHealthController {
  constructor(@Inject(PersonalHealthService) private readonly health: PersonalHealthService) {}

  @Get('overview')
  async overview(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OverviewPayload>> {
    return single(await this.health.overview(ctx), { locale });
  }

  @Get('documents')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListDocumentsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<DocumentPayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.health.list(ctx, query, page);
    return collection(items, total, page, { locale });
  }

  @Post('documents')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateDocumentDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.health.create(ctx, dto), { locale });
  }

  @Get('documents/:id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.health.get(ctx, id), { locale });
  }

  @Patch('documents/:id')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateDocumentDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.health.update(ctx, id, dto), { locale });
  }

  /** Moves the document to the trash (kept 30 days). */
  @Delete('documents/:id')
  @HttpCode(204)
  async trash(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.health.trash(ctx, id);
  }

  @Post('documents/:id/restore')
  @HttpCode(204)
  async restore(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.health.restore(ctx, id);
  }

  /** Removes a trashed document and its files now. */
  @Delete('documents/:id/permanent')
  @HttpCode(204)
  async removeForGood(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.health.removeForGood(ctx, id);
  }
}
