import { describe, expect, it } from 'vitest';

import { periodRange } from './finance-rules.js';

const CAIRO = 'Africa/Cairo';
// 2026-11-20 22:30 in Cairo (UTC+2) is 20:30 UTC.
const now = new Date('2026-11-20T20:30:00Z');

describe('periods in the account time zone', () => {
  it('today is the Cairo day, from Cairo midnight', () => {
    const r = periodRange('today', now, CAIRO);
    expect(r?.firstDay).toBe('2026-11-20');
    expect(r?.from.toISOString()).toBe('2026-11-19T22:00:00.000Z');
    expect(r?.to.toISOString()).toBe('2026-11-20T22:00:00.000Z');
  });

  it('a late-night purchase stays on its Cairo day', () => {
    // 23:45 Cairo on the 20th is 21:45 UTC on the 20th; 00:15 Cairo on the 21st is 22:15 UTC on the 20th.
    const r = periodRange('today', now, CAIRO);
    expect(new Date('2026-11-20T21:45:00Z') < (r?.to ?? now)).toBe(true);
    expect(new Date('2026-11-20T22:15:00Z') >= (r?.to ?? now)).toBe(true);
  });

  it('weeks start on Saturday', () => {
    const r = periodRange('week', now, CAIRO); // Friday the 20th
    expect(r?.firstDay).toBe('2026-11-14');
    expect(r?.lastDay).toBe('2026-11-20');
  });

  it('month and year cover whole calendar periods', () => {
    expect(periodRange('month', now, CAIRO)).toMatchObject({
      firstDay: '2026-11-01',
      lastDay: '2026-11-30',
    });
    expect(periodRange('month', new Date('2028-02-10T10:00:00Z'), CAIRO)?.lastDay).toBe(
      '2028-02-29',
    );
    expect(periodRange('year', now, CAIRO)).toMatchObject({
      firstDay: '2026-01-01',
      lastDay: '2026-12-31',
    });
  });

  it('a custom range needs valid, ordered days', () => {
    expect(
      periodRange('custom', now, CAIRO, { from: '2026-10-01', to: '2026-10-31' }),
    ).toMatchObject({
      firstDay: '2026-10-01',
      lastDay: '2026-10-31',
    });
    expect(periodRange('custom', now, CAIRO, { from: '2026-10-31', to: '2026-10-01' })).toBeNull();
    expect(periodRange('custom', now, CAIRO, { from: '2026-02-30', to: '2026-03-01' })).toBeNull();
    expect(periodRange('custom', now, CAIRO, {})).toBeNull();
  });
});
