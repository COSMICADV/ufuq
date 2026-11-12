import { describe, expect, it } from 'vitest';

import {
  cleanRecord,
  countryCode,
  describeAgent,
  localDayAndMinutes,
  primaryLanguage,
  rangeCovers,
  safeHttpUrl,
  websiteTarget,
} from './qr-rules.js';

describe('cleanRecord', () => {
  it('keeps the studio record but drops what the server owns', () => {
    const clean = cleanRecord('menu-1', {
      id: 'other',
      name: '  Nile menu ',
      type: 'menu',
      data: { items: 'Tea | 20' },
      scans: 99,
      scanLog: [{ t: 'x' }],
      feedback: [{ stars: 5 }],
    });
    expect(clean).toEqual({
      slug: 'menu-1',
      name: 'Nile menu',
      type: 'menu',
      record: { id: 'menu-1', name: '  Nile menu ', type: 'menu', data: { items: 'Tea | 20' } },
    });
  });

  it.each([
    ['a', { type: 'menu' }],
    ['has space', { type: 'menu' }],
    ['ok-slug', { type: 'unknown' }],
    ['ok-slug', ['menu']],
    ['ok-slug', null],
  ])('refuses slug %s with %j', (slug, input) => {
    expect(cleanRecord(slug, input)).toBeNull();
  });

  it('names an unnamed code after its slug', () => {
    expect(cleanRecord('abc', { type: 'text' })?.name).toBe('abc');
  });
});

describe('safeHttpUrl', () => {
  it('accepts web addresses only', () => {
    expect(safeHttpUrl('https://wilo-eg.com')).toBe('https://wilo-eg.com/');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,hi')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(42)).toBeNull();
  });
});

describe('time ranges', () => {
  // 2026-11-12 is a Thursday; 10:30 UTC is 12:30 in Cairo (UTC+2).
  const thursdayNoonCairo = new Date('2026-11-12T10:30:00Z');

  it('reads the day and time in the code time zone', () => {
    expect(localDayAndMinutes(thursdayNoonCairo, 'Africa/Cairo')).toEqual({
      day: 4,
      minutes: 12 * 60 + 30,
    });
  });

  it('covers a daytime range on its days only', () => {
    const range = { days: [4], start: '09:00', end: '17:00' };
    expect(rangeCovers(range, 4, 12 * 60)).toBe(true);
    expect(rangeCovers(range, 5, 12 * 60)).toBe(false);
    expect(rangeCovers(range, 4, 17 * 60)).toBe(false);
  });

  it('wraps a range past midnight into the next morning', () => {
    const range = { days: [5], start: '20:00', end: '02:00' };
    expect(rangeCovers(range, 5, 21 * 60)).toBe(true);
    expect(rangeCovers(range, 6, 60)).toBe(true);
    expect(rangeCovers(range, 6, 21 * 60)).toBe(false);
  });
});

describe('websiteTarget', () => {
  const now = new Date('2026-11-12T10:30:00Z');
  const ctx = { country: 'EG', lang: 'ar', now };

  it('uses the plain address without a site list', () => {
    expect(websiteTarget({ data: { url: 'https://a.example' } }, ctx)).toBe('https://a.example/');
  });

  it('picks the site for the visitor country, language and hour, with its parameters', () => {
    const record = {
      data: { url: 'https://fallback.example' },
      page: {
        web: {
          mc: true,
          ml: true,
          timeOn: true,
          tz: 'Africa/Cairo',
          langs: ['en', 'ar'],
          ranges: [
            { id: 'day', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
            { id: 'night', days: [1, 2, 3, 4, 5], start: '17:00', end: '23:00' },
          ],
          sites: [
            { urls: { en: 'https://sa.example' }, countries: ['SA'], ranges: [] },
            {
              urls: { en: 'https://eg-night.example', ar: 'https://eg-night.example/ar' },
              countries: ['EG'],
              ranges: ['night'],
            },
            {
              urls: { en: 'https://eg.example', ar: 'https://eg.example/ar' },
              countries: ['EG'],
              ranges: ['day'],
              params: [{ k: 'utm_source', v: 'qr' }],
            },
          ],
        },
      },
    };
    expect(websiteTarget(record, ctx)).toBe('https://eg.example/ar?utm_source=qr');
    expect(websiteTarget(record, { ...ctx, lang: 'fr' })).toBe('https://eg.example/?utm_source=qr');
    expect(websiteTarget(record, { ...ctx, country: 'SA' })).toBe('https://sa.example/');
    // Nobody matches (an unlisted country): the first site.
    expect(websiteTarget(record, { ...ctx, country: 'US' })).toBe('https://sa.example/');
  });

  it('never redirects to a non-web address', () => {
    const record = {
      data: { url: 'javascript:alert(1)' },
      page: { web: { sites: [{ urls: { en: 'javascript:alert(1)' } }] } },
    };
    expect(websiteTarget(record, ctx)).toBeNull();
  });
});

describe('visitor details', () => {
  it('reads system and browser', () => {
    expect(
      describeAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ os: 'iOS', browser: 'Safari' });
    expect(
      describeAgent(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
      ),
    ).toEqual({ os: 'Android', browser: 'Chrome' });
    expect(describeAgent(null)).toEqual({ os: 'Other', browser: 'Other' });
  });

  it('reads the first language and a country code', () => {
    expect(primaryLanguage('ar-EG,ar;q=0.9,en;q=0.8')).toBe('ar');
    expect(primaryLanguage('*')).toBeNull();
    expect(countryCode('eg')).toBe('EG');
    expect(countryCode('XX')).toBeNull();
    expect(countryCode('Egypt')).toBeNull();
  });
});
