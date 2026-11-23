import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFiles,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Locale } from '@ufuq/i18n';
import type { Response } from 'express';

import { UploadTooLargeFilter } from '../attachments/upload-too-large.filter.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { LogoQueryDto, OnboardingDto, UpdateIdentityDto, UploadLogoDto } from './identity.dto.js';
import { IdentityService } from './identity.service.js';
import type { IdentityPayload, UploadedPart } from './identity.service.js';

/**
 * `/business-identity` — read by anyone in the company, changed only with
 * `settings.update` (checked in the service, so the read stays open to the
 * employees whose receipts and documents show it).
 */
@Controller('business-identity')
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get()
  async get(@CurrentUser() ctx: AuthContext, @RequestLocale() locale: Locale): Promise<SingleResponse<IdentityPayload>> {
    return single(await this.identity.get(ctx), { locale });
  }

  @Patch()
  async update(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: UpdateIdentityDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<IdentityPayload>> {
    return single(await this.identity.update(ctx, dto, origin), { locale });
  }

  @Post('logo')
  @HttpCode(200)
  @UseInterceptors(FileFieldsInterceptor([{ name: 'logo', maxCount: 1 }, { name: 'thermal', maxCount: 1 }]))
  @UseFilters(UploadTooLargeFilter)
  async upload(
    @CurrentUser() ctx: AuthContext,
    @UploadedFiles() files: { logo?: UploadedPart[]; thermal?: UploadedPart[] } | undefined,
    @Body() dto: UploadLogoDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<IdentityPayload>> {
    const print = dto.print_logo === undefined ? undefined : dto.print_logo === 'true';
    return single(await this.identity.uploadLogo(ctx, files?.logo?.[0], files?.thermal?.[0], print, origin), { locale });
  }

  @Delete('logo')
  async remove(
    @CurrentUser() ctx: AuthContext,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<IdentityPayload>> {
    return single(await this.identity.removeLogo(ctx, origin), { locale });
  }

  @Get('logo')
  async logo(
    @CurrentUser() ctx: AuthContext,
    @Query() query: LogoQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.identity.logo(ctx, query.variant ?? 'main');
    response.set({
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly can neither run script nor load anything.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    return new StreamableFile(file.stream);
  }

  @Post('onboarding')
  @HttpCode(200)
  async onboarding(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: OnboardingDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<IdentityPayload>> {
    return single(await this.identity.onboarding(ctx, dto.action), { locale });
  }
}
