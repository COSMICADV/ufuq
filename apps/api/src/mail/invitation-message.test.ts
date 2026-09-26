import { describe, expect, it } from 'vitest';

import { buildInvitationMessage, invitationLink } from './invitation-message.js';

const BASE = {
  to: 'sara@company.test',
  token: 'tok/en+with=unsafe&chars',
  firstName: 'سارة',
  companyName: 'Acme <Trading> & Sons',
  // 21:30 UTC is 00:30 the next day in Cairo (UTC+3 in September).
  expiresAt: new Date('2026-09-16T21:30:00.000Z'),
  timeZone: 'Africa/Cairo',
  webOrigin: 'https://app.ufuq.example',
} as const;

describe('invitationLink — DOCUMENT 20 §6', () => {
  it('carries the token in the fragment, never the query string', () => {
    const link = new URL(invitationLink(BASE.webOrigin, 'ar', 'abc'));
    expect(link.search).toBe('');
    expect(link.hash).toBe('#token=abc');
    expect(link.pathname).toBe('/ar/accept-invitation');
  });

  it('encodes a token so it survives the round trip intact', () => {
    const link = new URL(invitationLink(BASE.webOrigin, 'en', BASE.token));
    const token = decodeURIComponent(link.hash.slice('#token='.length));
    expect(token).toBe(BASE.token);
  });
});

describe('buildInvitationMessage', () => {
  it('writes Arabic mail right to left and English mail left to right', () => {
    expect(buildInvitationMessage({ ...BASE, locale: 'ar' }).html).toContain(
      '<html lang="ar" dir="rtl">',
    );
    expect(buildInvitationMessage({ ...BASE, locale: 'en' }).html).toContain(
      '<html lang="en" dir="ltr">',
    );
  });

  it('escapes tenant-supplied text in the HTML part', () => {
    const { html, text } = buildInvitationMessage({ ...BASE, locale: 'en' });
    expect(html).toContain('Acme &lt;Trading&gt; &amp; Sons');
    expect(html).not.toContain('<Trading>');
    // The plain-text part is not HTML and is not escaped.
    expect(text).toContain('Acme <Trading> & Sons');
  });

  it('puts the same link in both parts, and names the company in the subject', () => {
    const message = buildInvitationMessage({ ...BASE, locale: 'en' });
    const link = invitationLink(BASE.webOrigin, 'en', BASE.token);
    expect(message.text).toContain(link);
    expect(message.html).toContain(link.replace(/&/g, '&amp;'));
    expect(message.subject).toContain(BASE.companyName);
    expect(message.to).toBe(BASE.to);
  });

  it('states the expiry in the company time zone, not UTC', () => {
    const { text } = buildInvitationMessage({ ...BASE, locale: 'en' });
    expect(text).toContain('17 Sept 2026');
  });
});
