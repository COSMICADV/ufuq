import { describe, expect, it } from 'vitest';

import {
  authorizeUrl,
  GoogleAuthError,
  newOAuthState,
  openState,
  pkceChallenge,
  profileFromIdToken,
  sealState,
} from './google-oauth.js';

const config = {
  clientId: 'client-1',
  clientSecret: 'secret-1',
  redirectUri: 'https://app.test/cb',
};
const jwt = (claims: object): string =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const now = 1_800_000_000;
const good = {
  iss: 'https://accounts.google.com',
  aud: 'client-1',
  exp: now + 300,
  nonce: 'n-1',
  sub: '123',
  email: 'Person@Gmail.com',
  email_verified: true,
  name: 'Sara',
};

describe('Google sign-in state', () => {
  it('round-trips a sealed state and refuses tampering, other keys and expiry', () => {
    const state = newOAuthState('personal', 'fr', true, 1000);
    const sealed = sealState(state, 'secret-1');
    expect(openState(sealed, 'secret-1', 2000)).toEqual(state);
    expect(openState(sealed, 'other-secret', 2000)).toBeNull();
    expect(openState(`${sealed}x`, 'secret-1', 2000)).toBeNull();
    const [payload] = sealed.split('.');
    const forged = Buffer.from(JSON.stringify({ ...state, intent: 'signin' })).toString(
      'base64url',
    );
    expect(openState(`${forged}.${sealed.split('.')[1] ?? ''}`, 'secret-1', 2000)).toBeNull();
    expect(payload).toBeTruthy();
    expect(openState(sealed, 'secret-1', state.expiresAt + 1)).toBeNull();
    expect(openState(undefined, 'secret-1', 2000)).toBeNull();
  });

  it('asks Google for openid email profile with PKCE S256', () => {
    const state = newOAuthState('signin', 'ar', false, 0);
    const url = new URL(authorizeUrl(config, state));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('code_challenge')).toBe(pkceChallenge(state.verifier));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(state.state);
    expect(url.searchParams.get('nonce')).toBe(state.nonce);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/cb');
  });
});

describe('Google ID token claims', () => {
  it('returns the verified, lower-cased email and the name', () => {
    expect(profileFromIdToken(jwt(good), config, 'n-1', now)).toEqual({
      email: 'person@gmail.com',
      name: 'Sara',
      subject: '123',
    });
  });

  it.each([
    ['issuer', { iss: 'https://evil.test' }],
    ['audience', { aud: 'someone-else' }],
    ['expiry', { exp: now - 1 }],
    ['nonce', { nonce: 'other' }],
  ])('refuses a wrong %s', (_label, change) => {
    expect(() => profileFromIdToken(jwt({ ...good, ...change }), config, 'n-1', now)).toThrow(
      GoogleAuthError,
    );
  });

  it('refuses an unverified email and a malformed token', () => {
    expect(() =>
      profileFromIdToken(jwt({ ...good, email_verified: false }), config, 'n-1', now),
    ).toThrow(/email_unverified/);
    expect(() => profileFromIdToken('not-a-jwt', config, 'n-1', now)).toThrow(/invalid_token/);
  });
});
