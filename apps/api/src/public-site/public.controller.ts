import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { Locale } from '@ufuq/i18n';
import { Public } from '../auth/decorators/public.decorator.js';
import { AppException } from '../common/app-exception.js';
import { ERROR_CODES } from '../common/errors.js';
import { RequestLocale } from '../common/request-locale.js';
import { single } from '../common/envelope.js';
import { PublicWriteGuard } from './public-write.guard.js';
import { PublicSiteService } from './public.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DTO runtime metadata
import { ContactDto, RegisterDto } from './public.dto.js';

@Public()
@Controller('public')
@UseGuards(PublicWriteGuard)
export class PublicSiteController {
  constructor(@Inject(PublicSiteService) private readonly service: PublicSiteService) {}
  @Post('contact')
  @HttpCode(200)
  async contact(
    @Body() dto: ContactDto,
    @Req() request: Request,
    @RequestLocale() locale: Locale,
  ): Promise<unknown> {
    await this.service.protect(dto, request.headers.origin);
    await this.service.contact(dto);
    return single({}, { locale });
  }
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() request: Request,
    @RequestLocale() locale: Locale,
  ): Promise<unknown> {
    await this.service.protect(dto, request.headers.origin);
    try {
      await this.service.register(dto, locale);
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw new AppException(ERROR_CODES.INTERNAL_ERROR, 500);
    }
    return single({}, { locale });
  }
}
