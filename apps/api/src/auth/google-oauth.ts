/**
 * "Continue with Google" — OpenID Connect authorization-code flow with PKCE.
 *
 * Nothing is stored server-side between the two legs: the state, the PKCE
 * verifier and the nonce travel in one short-lived, HttpOnly cookie, signed
 * with HMAC-SHA256 under the Google client secret, so it can neither be read
 * by page script nor altered. The callback must present the same `state` in
 * the URL as in that cookie (login-CSRF protection), within ten minutes.
 *
 * The ID token is taken from Google's token endpoint directly, over TLS,
 * with our client secret; OpenID Connect Core §3.1.3.7 lets a client in
 * that position rely on the TLS channel instead of the token's signature.
 * Its claims are still checked: issuer, audience, expiry, nonce, and a
 * verified email.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const OAUTH_COOKIE_NAME = 'ufuq_google_oauth';
export const OAUTH_COOKIE_PATH = '/api/v1/auth/google';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Where the visitor started: Personal sign-up, or the shared sign-in page. */
export type GoogleIntent = 'personal' | 'signin';

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface OAuthState {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly intent: GoogleIntent;
  readonly locale: string;
  readonly remember: boolean;
  /** Epoch milliseconds after which the state is refused. */
  readonly expiresAt: number;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

export function newOAuthState(
  intent: GoogleIntent,
  locale: string,
  remember: boolean,
  now: number,
): OAuthState {
  return {
    state: base64url(randomBytes(24)),
    verifier: base64url(randomBytes(48)),
    nonce: base64url(randomBytes(24)),
    intent,
    locale,
    remember,
    expiresAt: now + OAUTH_STATE_TTL_MS,
  };
}

/** PKCE S256 challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function authorizeUrl(config: GoogleConfig, state: OAuthState): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state.state);
  url.searchParams.set('nonce', state.nonce);
  url.searchParams.set('code_challenge', pkceChallenge(state.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

/** `payload.signature`, both base64url. */
export function sealState(state: OAuthState, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(state)));
  return `${payload}.${sign(payload, secret)}`;
}

function isIntent(value: unknown): value is GoogleIntent {
  return value === 'personal' || value === 'signin';
}

/** The state from the cookie, or null when missing, altered, malformed or expired. */
export function openState(
  sealed: string | undefined,
  secret: string,
  now: number,
): OAuthState | null {
  if (typeof sealed !== 'string') return null;
  const [payload, signature, extra] = sealed.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const s = parsed as Record<string, unknown>;
  if (
    typeof s['state'] !== 'string' ||
    typeof s['verifier'] !== 'string' ||
    typeof s['nonce'] !== 'string' ||
    !isIntent(s['intent']) ||
    typeof s['locale'] !== 'string' ||
    typeof s['remember'] !== 'boolean' ||
    typeof s['expiresAt'] !== 'number'
  )
    return null;
  if (s['expiresAt'] <= now) return null;
  return {
    state: s['state'],
    verifier: s['verifier'],
    nonce: s['nonce'],
    intent: s['intent'],
    locale: s['locale'],
    remember: s['remember'],
    expiresAt: s['expiresAt'],
  };
}

/** Constant-time comparison of the URL's state with the cookie's. */
export function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface GoogleProfile {
  readonly email: string;
  readonly name: string;
  readonly subject: string;
}

/** Why a Google answer was refused; each maps to a message on the web. */
export type GoogleFailure = 'exchange_failed' | 'invalid_token' | 'email_unverified';

export class GoogleAuthError extends Error {
  constructor(readonly reason: GoogleFailure) {
    super(`google sign-in refused: ${reason}`);
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) throw new GoogleAuthError('invalid_token');
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error('not an object');
    return value as Record<string, unknown>;
  } catch {
    throw new GoogleAuthError('invalid_token');
  }
}

/** Checks the ID token's claims and returns who signed in. */
export function profileFromIdToken(
  idToken: string,
  config: GoogleConfig,
  nonce: string,
  nowSeconds: number,
): GoogleProfile {
  const claims = decodeJwtPayload(idToken);
  const iss = claims['iss'];
  const aud = claims['aud'];
  const exp = claims['exp'];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (
    (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') ||
    !audiences.includes(config.clientId) ||
    typeof exp !== 'number' ||
    exp <= nowSeconds ||
    claims['nonce'] !== nonce ||
    typeof claims['sub'] !== 'string' ||
    typeof claims['email'] !== 'string'
  ) {
    throw new GoogleAuthError('invalid_token');
  }
  if (claims['email_verified'] !== true && claims['email_verified'] !== 'true') {
    throw new GoogleAuthError('email_unverified');
  }
  const email = claims['email'].trim().toLowerCase();
  const name =
    typeof claims['name'] === 'string' && claims['name'].trim()
      ? claims['name'].trim()
      : (email.split('@')[0] ?? email);
  return { email, name: name.slice(0, 200), subject: claims['sub'] };
}

/** Trades the authorization code for tokens at Google's token endpoint. */
export async function exchangeCode(
  config: GoogleConfig,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GoogleAuthError('exchange_failed');
  }
  if (!response.ok) throw new GoogleAuthError('exchange_failed');
  const body: unknown = await response.json().catch(() => null);
  const idToken =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['id_token']
      : null;
  if (typeof idToken !== 'string') throw new GoogleAuthError('exchange_failed');
  return idToken;
}
