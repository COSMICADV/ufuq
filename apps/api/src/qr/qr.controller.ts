/**
 * QR Studio — the studio's endpoints (signed in) and the public scan page's.
 *
 * Studio (company owner and admins; the service checks the role):
 *   GET    /qr/codes               the company's codes with their statistics
 *   PUT    /qr/codes/{slug}        create or replace a code
 *   DELETE /qr/codes/{slug}
 *   POST   /qr/codes/{slug}/reset  clear a code's statistics
 *   GET    /qr/slugs/{slug}        whether a short link is free
 *   POST   /qr/files               upload a file for a code (PDF, video, audio, picture)
 *
 * Public (no session; whoever scans a code):
 *   POST   /public/qr/{slug}/scan      count a scan; returns the page or the redirect
 *   POST   /public/qr/{slug}/event     a tracked click on the page
 *   POST   /public/qr/{slug}/feedback  a rating on a feedback code
 *   GET    /public/qr/files/{id}       an uploaded file
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Locale } from '@ufuq/i18n';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Public } from '../auth/decorators/public.decorator.js';
import type { UploadedFile as UploadedFileShape } from '../attachments/attachments.service.js';
import { UploadTooLargeFilter } from '../attachments/upload-too-large.filter.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { QrEventDto, QrFeedbackDto, QrSaveDto, QrScanDto } from './qr.dto.js';
import { countryCode, describeAgent, primaryLanguage } from './qr-rules.js';
import { QrService } from './qr.service.js';
import type { QrCodePayload, QrScanPage } from './qr.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('qr')
export class QrController {
  constructor(@Inject(QrService) private readonly qr: QrService) {}

  @Get('codes')
  async list(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ codes: QrCodePayload[] }>> {
    return single({ codes: await this.qr.list(ctx) }, { locale });
  }

  @Put('codes/:slug')
  async save(
    @CurrentUser() ctx: AuthContext,
    @Param('slug') slug: string,
    @Body() dto: QrSaveDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ id: string }>> {
    return single(await this.qr.save(ctx, slug, dto.rec), { locale });
  }

  @Delete('codes/:slug')
  @HttpCode(204)
  async remove(@CurrentUser() ctx: AuthContext, @Param('slug') slug: string): Promise<void> {
    await this.qr.remove(ctx, slug);
  }

  @Post('codes/:slug/reset')
  @HttpCode(204)
  async reset(@CurrentUser() ctx: AuthContext, @Param('slug') slug: string): Promise<void> {
    await this.qr.reset(ctx, slug);
  }

  @Get('slugs/:slug')
  async slug(
    @CurrentUser() ctx: AuthContext,
    @Param('slug') slug: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ free: boolean }>> {
    return single({ free: await this.qr.slugFree(ctx, slug) }, { locale });
  }

  @Post('files')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(UploadTooLargeFilter)
  async upload(
    @CurrentUser() ctx: AuthContext,
    @UploadedFile() file: UploadedFileShape | undefined,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ id: string }>> {
    return single(await this.qr.upload(ctx, file), { locale });
  }
}

@Public()
@Controller('public/qr')
export class QrPublicController {
  constructor(@Inject(QrService) private readonly qr: QrService) {}

  /**
   * Called by the web app's `/q/{slug}` route, which forwards the visitor's
   * headers. The country comes from the edge (`cf-ipcountry`) when there is one.
   */
  @Post(':slug/scan')
  @HttpCode(200)
  async scan(
    @Param('slug') slug: string,
    @Body() dto: QrScanDto,
    @Headers('user-agent') userAgent: string | undefined,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Headers('cf-ipcountry') edgeCountry: string | undefined,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<QrScanPage>> {
    const agent = describeAgent(userAgent ?? null);
    const page = await this.qr.scan(slug, {
      unique: dto.unique === true,
      os: agent.os,
      browser: agent.browser,
      lang: primaryLanguage(acceptLanguage ?? null),
      country: countryCode(dto.country ?? edgeCountry ?? null),
      city: dto.city?.slice(0, 80) ?? null,
      now: new Date(),
    });
    return single(page, { locale });
  }

  @Post(':slug/event')
  @HttpCode(204)
  async event(
    @Param('slug') slug: string,
    @Body() dto: QrEventDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Headers('cf-ipcountry') edgeCountry: string | undefined,
  ): Promise<void> {
    await this.qr.event(slug, dto.name, {
      lang: primaryLanguage(acceptLanguage ?? null),
      country: countryCode(edgeCountry ?? null),
      now: new Date(),
    });
  }

  @Post(':slug/feedback')
  @HttpCode(204)
  async feedback(@Param('slug') slug: string, @Body() dto: QrFeedbackDto): Promise<void> {
    await this.qr.feedback(slug, dto.stars, dto.text ?? '');
  }

  @Get('files/:id')
  async file(
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.qr.file(id);
    response.set({
      'Content-Type': file.contentType,
      'Content-Length': String(file.sizeBytes),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'public, max-age=86400',
      // The scan page and the studio both embed these (PDF viewer, <video>).
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    return new StreamableFile(file.stream);
  }
}
