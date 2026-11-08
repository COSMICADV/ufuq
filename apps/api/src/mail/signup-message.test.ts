import { describe, expect, it } from 'vitest';

import {
  buildSignupApprovedMessage,
  buildSignupRequestMessage,
  ownerReviewLink,
} from './signup-message.js';

const request = {
  to: 'owner@example.test',
  webOrigin: 'https://app.example.test',
  ownerKey: 'k'.repeat(40),
  companyId: '0192f000-0000-7000-8000-000000000001',
  companyName: '<b>Nile</b> & Co',
  adminName: 'مريم',
  adminEmail: 'mariam@example.test',
  adminPhone: '+201000000000',
  employeeCountRange: '11-50',
  requestedAt: new Date('2026-11-08T09:30:00Z'),
};

describe('owner review link', () => {
  it('carries the key and request in the fragment, never the query', () => {
    const url = new URL(ownerReviewLink(request.webOrigin, request.ownerKey, request.companyId));
    expect(url.pathname).toBe('/en/owner');
    expect(url.search).toBe('');
    const hash = new URLSearchParams(url.hash.slice(1));
    expect(hash.get('key')).toBe(request.ownerKey);
    expect(hash.get('request')).toBe(request.companyId);
  });
  it('still points at the request when no key is configured', () => {
    const url = new URL(ownerReviewLink(request.webOrigin, null, request.companyId));
    expect(new URLSearchParams(url.hash.slice(1)).has('key')).toBe(false);
  });
});

describe('sign-up request email', () => {
  it('lists the details, replies to the visitor and escapes HTML', () => {
    const m = buildSignupRequestMessage(request);
    expect(m.to).toBe('owner@example.test');
    expect(m.replyTo).toBe('mariam@example.test');
    expect(m.subject).toContain('<b>Nile</b> & Co');
    for (const value of ['مريم', 'mariam@example.test', '+201000000000', '11-50'])
      expect(m.text).toContain(value);
    expect(m.html).not.toContain('<b>Nile</b>');
    expect(m.html).toContain('&lt;b&gt;Nile&lt;/b&gt; &amp; Co');
  });
});

describe('approved email', () => {
  it('links to sign-in in the visitor’s language', () => {
    const ar = buildSignupApprovedMessage({
      to: 'a@example.test',
      locale: 'ar',
      webOrigin: 'https://app.example.test',
      name: 'مريم',
      companyName: 'النيل',
    });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('https://app.example.test/ar/login');
    const en = buildSignupApprovedMessage({
      to: 'a@example.test',
      locale: 'en',
      webOrigin: 'https://app.example.test',
      name: 'Mariam',
      companyName: 'Nile',
    });
    expect(en.subject).toContain('1to1OS');
    expect(en.text).toContain('https://app.example.test/en/login');
  });
});
