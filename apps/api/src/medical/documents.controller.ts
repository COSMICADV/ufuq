import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { CategoryDto, CreateDocumentDto, ListDocumentsQueryDto, UpdateCategoryDto, UpdateDocumentDto } from './documents.dto.js';
import { DocumentsService } from './documents.service.js';
import type { CategoryPayload, DocumentListPayload, DocumentPayload } from './documents.service.js';

const uuid = new ParseUUIDPipe();

/**
 * Medical documents. Pages are added and read through /attachments
 * (`related_type = medical_document`); every permission is checked in the
 * service and in the attachment policy.
 */
@Controller('medical')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Get('document-categories')
  async categories(@CurrentUser() ctx: AuthContext, @RequestLocale() locale: Locale): Promise<SingleResponse<CategoryPayload[]>> {
    return single(await this.documents.categories(ctx), { locale });
  }

  @Post('document-categories')
  async createCategory(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CategoryDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CategoryPayload>> {
    return single(await this.documents.createCategory(ctx, dto, origin), { locale });
  }

  @Patch('document-categories/:id')
  async updateCategory(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCategoryDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CategoryPayload>> {
    return single(await this.documents.updateCategory(ctx, id, dto, origin), { locale });
  }

  @Get('patients/:id/documents')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: ListDocumentsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentListPayload>> {
    return single(
      await this.documents.list(ctx, id, { ...(query.kind ? { kind: query.kind } : {}), archived: query.archived === 'true' }),
      { locale },
    );
  }

  @Post('patients/:id/documents')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CreateDocumentDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.documents.create(ctx, id, dto, origin), { locale });
  }

  @Get('documents/:id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.documents.get(ctx, id), { locale });
  }

  @Patch('documents/:id')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateDocumentDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.documents.update(ctx, id, dto, origin), { locale });
  }

  @Post('documents/:id/archive')
  @HttpCode(200)
  async archive(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.documents.setArchived(ctx, id, true, origin), { locale });
  }

  @Post('documents/:id/restore')
  @HttpCode(200)
  async restore(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DocumentPayload>> {
    return single(await this.documents.setArchived(ctx, id, false, origin), { locale });
  }

  @Delete('documents/:id')
  @HttpCode(204)
  async remove(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string, @RequestContext() origin: RequestOrigin): Promise<void> {
    await this.documents.remove(ctx, id, origin);
  }
}
