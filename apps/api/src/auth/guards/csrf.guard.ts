/**
 * Double-submit CSRF check for the cookie-authenticated web client —
 * DOCUMENT 20 §6: "CSRF tokens on all state-changing requests for the
 * cookie-authenticated web client."
 *
 * `SameSite=Lax` (DOCUMENT 09 §3) already blocks a cross-site *form* POST
 * from attaching the session cookie, but DOCUMENT 20 §6 asks for the token
 * as well, so this is defence in depth rather than the only control. Mobile
 * (Bearer-token) requests carry no cookie at all and are exempt by
 * construction: a forged cross-site request cannot attach a header the
 * browser does not send automatically.
 */

import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import { timingSafeEqualStrings } from '@ufuq/auth';
import type { Request } from 'express';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../cookies.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request>();

    if (
      isPublic ||
      SAFE_METHODS.has(request.method) ||
      request.authContext?.clientType === 'mobile'
    ) {
      return true;
    }

    const cookieToken = request.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
    const headerToken = request.headers[CSRF_HEADER_NAME];
    const headerValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;

    if (!cookieToken || !headerValue || !timingSafeEqualStrings(cookieToken, headerValue)) {
      throw new ForbiddenException();
    }
    return true;
  }
}
