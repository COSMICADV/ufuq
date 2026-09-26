/**
 * Locale negotiation — DOCUMENT 08 §1: `Accept-Language: ar | en`, default `ar`.
 *
 * The header is the only input. Resolution itself belongs to @ufuq/i18n, so the
 * API does not hold a second opinion about what a locale is.
 */

import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { resolveLocale } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import type { Request } from 'express';

export const RequestLocale = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Locale => {
    const request = context.switchToHttp().getRequest<Request>();
    return resolveLocale(request.headers['accept-language']);
  },
);
