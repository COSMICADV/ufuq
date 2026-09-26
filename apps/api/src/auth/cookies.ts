/**
 * Web session cookies — DOCUMENT 09 §3, DOCUMENT 20 §6.
 *
 * Two cookies: `ufuq_session` (httpOnly — the session token itself, never
 * readable by page JavaScript) and `ufuq_csrf` (not httpOnly — a
 * double-submit CSRF token the frontend must read and echo back in an
 * `X-CSRF-Token` header on every mutating request). Bearer-token (mobile)
 * requests carry neither and are exempt from CSRF checking by construction:
 * a request that must already carry a header the browser will not attach
 * automatically is not vulnerable to cross-site *forgery* in the first place.
 */

import { generateOpaqueToken } from '@ufuq/auth';
import type { Env } from '@ufuq/config';
import type { Response } from 'express';

export const SESSION_COOKIE_NAME = 'ufuq_session';
export const CSRF_COOKIE_NAME = 'ufuq_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';

function cookieOptions(env: Env, expiresAt: Date, httpOnly: boolean) {
  return {
    httpOnly,
    // `Secure` requires HTTPS; local development is plain HTTP, so it is
    // only enabled once the environment claims to be one where HTTPS is
    // actually in front of the API (DOCUMENT 20 §6).
    secure: env.nodeEnv === 'production' || env.nodeEnv === 'staging',
    sameSite: 'lax' as const,
    path: '/',
    expires: expiresAt,
  };
}

export function setSessionCookies(
  response: Response,
  env: Env,
  sessionToken: string,
  expiresAt: Date,
): void {
  response.cookie(SESSION_COOKIE_NAME, sessionToken, cookieOptions(env, expiresAt, true));
  response.cookie(CSRF_COOKIE_NAME, generateOpaqueToken(), cookieOptions(env, expiresAt, false));
}

export function clearSessionCookies(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  response.clearCookie(CSRF_COOKIE_NAME, { path: '/' });
}
