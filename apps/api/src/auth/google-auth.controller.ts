import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import { isLocale } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import type { Request, Response } from 'express';

import { APP_ENV } from '../app.tokens.js';
import { AppException } from '../common/app-exception.js';
import { single } from '../common/envelope.js';
import { AuditDispatcher } from './audit-dispatcher.js';
import { AuthService } from './auth.service.js';
import { setSessionCookies } from './cookies.js';
import { Public } from './decorators/public.decorator.js';
import {
  authorizeUrl,
  exchangeCode,
  GoogleAuthError,
  newOAuthState,
  OAUTH_COOKIE_NAME,
  OAUTH_COOKIE_PATH,
  OAUTH_STATE_TTL_MS,
  openState,
  profileFromIdToken,
  sameState,
  sealState,
} from './google-oauth.js';
import type { GoogleIntent } from './google-oauth.js';
import { createPersonalAccount } from './personal-account.js';
import { RateLimitService } from './rate-limit.service.js';

/** Where each role's workspace opens — the web's `workspaceFor`. */
export function workspacePath(locale: Locale, roleKey: string): string {
  if (roleKey === 'personal') return `/${locale}/personal`;
  if (roleKey === 'employee') return `/${locale}/app`;
  if (roleKey === 'admin') return `/${locale}/admin/settings/company`;
  return `/${locale}/admin`;
}

/** The reason shown on the page the visitor started from. */
function failureCode(error: unknown): string {
  if (error instanceof GoogleAuthError)
    return error.reason === 'email_unverified' ? 'unverified' : 'failed';
  if (error instanceof AppException) {
    switch (error.appErrorCode) {
      case 'ACCOUNT_LOCKED':
        return 'locked';
      case 'ACCOUNT_DEACTIVATED':
        return 'deactivated';
      case 'ACCOUNT_NOT_ACTIVATED':
        return 'not_activated';
      case 'ACCOUNT_PENDING_APPROVAL':
        return 'pending';
      case 'ACCOUNT_REJECTED':
        return 'rejected';
      case 'COMPANY_INACTIVE':
        return 'inactive';
      case 'RATE_LIMITED':
        return 'rate';
      default:
        return 'failed';
    }
  }
  return 'failed';
}

/**
 * "Continue with Google" for 1to1OS Personal and Business.
 *
 * `start` sends the browser to Google; `callback` is where Google sends it
 * back. An email that already has an account signs in to it — Business or
 * Personal, under the same status rules as a password sign-in. A new email
 * gets a Personal account, but only when the visitor started from Personal
 * sign-up; from the shared sign-in page it is refused ("no account"), so no
 * Business account is ever created this way.
 */
@Public()
@Controller('auth')
export class GoogleAuthController {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  /** Which outside sign-ins are switched on, for the web to show its buttons. */
  @Get('providers')
  providers(): unknown {
    return single({ google: Boolean(this.env.google) }, { locale: 'en' });
  }

  @Get('google/start')
  start(
    @Query('intent') intentParam: string | undefined,
    @Query('locale') localeParam: string | undefined,
    @Query('remember') rememberParam: string | undefined,
    @Res() response: Response,
  ): void {
    const locale: Locale = localeParam !== undefined && isLocale(localeParam) ? localeParam : 'ar';
    const intent: GoogleIntent = intentParam === 'personal' ? 'personal' : 'signin';
    const google = this.env.google;
    if (!google) {
      response.redirect(302, this.back(locale, intent, 'unavailable'));
      return;
    }
    const state = newOAuthState(intent, locale, rememberParam === '1', Date.now());
    response.cookie(OAUTH_COOKIE_NAME, sealState(state, google.clientSecret), {
      httpOnly: true,
      secure: this.env.nodeEnv === 'production' || this.env.nodeEnv === 'staging',
      // Lax: the callback is a top-level GET navigation from Google.
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_STATE_TTL_MS,
    });
    response.redirect(302, authorizeUrl(google, state));
  }

  @Get('google/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') stateParam: string | undefined,
    @Query('error') errorParam: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const google = this.env.google;
    const cookies = (request as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const state = google
      ? openState(cookies[OAUTH_COOKIE_NAME], google.clientSecret, Date.now())
      : null;
    response.clearCookie(OAUTH_COOKIE_NAME, { path: OAUTH_COOKIE_PATH });
    const locale: Locale = state && isLocale(state.locale) ? state.locale : 'ar';
    const intent: GoogleIntent = state?.intent ?? 'signin';

    if (!google) return response.redirect(302, this.back(locale, intent, 'unavailable'));
    if (errorParam !== undefined)
      return response.redirect(302, this.back(locale, intent, 'cancelled'));
    if (!state || typeof stateParam !== 'string' || !sameState(stateParam, state.state) || !code)
      return response.redirect(302, this.back(locale, intent, 'expired'));

    const ctx = { ipAddress: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null };
    try {
      const limit = await this.limits.consume(
        `oauth:google:ip:${ctx.ipAddress ?? 'unknown'}`,
        20,
        900,
      );
      if (!limit.allowed) return response.redirect(302, this.back(locale, intent, 'rate'));

      const idToken = await exchangeCode(google, code, state.verifier);
      const profile = profileFromIdToken(
        idToken,
        google,
        state.nonce,
        Math.floor(Date.now() / 1000),
      );

      let result = await this.auth.loginWithVerifiedEmail(
        profile.email,
        state.remember,
        'web',
        ctx,
      );
      if (result === null) {
        if (intent !== 'personal')
          return response.redirect(302, this.back(locale, intent, 'no_account'));
        await createPersonalAccount(this.audit, {
          name: profile.name,
          email: profile.email,
          passwordHash: null,
          locale,
        });
        result = await this.auth.loginWithVerifiedEmail(profile.email, state.remember, 'web', ctx);
        if (result === null) return response.redirect(302, this.back(locale, intent, 'failed'));
      }
      setSessionCookies(response, this.env, result.session.token, result.session.expiresAt);
      return response.redirect(302, this.web(workspacePath(locale, result.user.roleKey)));
    } catch (error) {
      return response.redirect(302, this.back(locale, intent, failureCode(error)));
    }
  }

  private web(path: string): string {
    return `${this.env.webOrigin.replace(/\/$/, '')}${path}`;
  }

  /** Back to the page the visitor started from, with the reason. */
  private back(locale: Locale, intent: GoogleIntent, reason: string): string {
    const page = intent === 'personal' ? `/${locale}/personal/start` : `/${locale}/login`;
    return this.web(`${page}?oauth=${encodeURIComponent(reason)}`);
  }
}
