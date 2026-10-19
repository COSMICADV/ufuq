/**
 * Notifications on the web — DOCUMENT 19 rules 5–6 and "Mobile behaviour",
 * DOCUMENT 11 §7.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  badgeLabel,
  groupByDay,
  inLocale,
  notificationHref,
  UnreadCounter,
  UNREAD_POLL_MS,
} from './notifications';
import type { NotificationItem } from './notifications';

function item(
  overrides: Partial<Omit<NotificationItem, 'related'>> & {
    readonly related?: Partial<NotificationItem['related']>;
  },
): NotificationItem {
  const { related, ...rest } = overrides;
  return {
    id: 'n1',
    type: 'task_assigned',
    priority: 'high',
    audience: 'employee',
    title: { ar: 'مهمة جديدة', en: 'New task' },
    body: { ar: 'نص', en: 'Body' },
    group_count: 1,
    is_summary: false,
    read_at: null,
    handled_at: null,
    created_at: '2026-05-10T08:00:00.000Z',
    ...rest,
    related: { type: 'task', id: 't1', available: true, meta: null, ...related },
  };
}

describe('where a notification goes (DOCUMENT 19 rule 5)', () => {
  it('opens the source on the side the notification belongs to', () => {
    expect(notificationHref('ar', item({}))).toBe('/ar/app/tasks/t1');
    expect(notificationHref('en', item({ audience: 'admin', type: 'task_overdue' }))).toBe(
      '/en/admin/tasks/t1',
    );
    expect(
      notificationHref(
        'en',
        item({ type: 'leave_approved', related: { type: 'request', id: 'r1' } }),
      ),
    ).toBe('/en/app/requests/r1');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'leave_request_submitted',
          related: { type: 'request', id: 'r1' },
        }),
      ),
    ).toBe('/en/admin/requests/r1');
    expect(
      notificationHref(
        'en',
        item({ audience: 'admin', type: 'low_stock', related: { type: 'product', id: 'p1' } }),
      ),
    ).toBe('/en/admin/inventory/p1');
    expect(
      notificationHref(
        'en',
        item({ type: 'salary_finalized', related: { type: 'payroll_period', id: 'pp1' } }),
      ),
    ).toBe('/en/app/salary/pp1');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'payroll_ready',
          related: { type: 'payroll_period', id: 'pp1' },
        }),
      ),
    ).toBe('/en/admin/payroll/pp1');
    expect(
      notificationHref(
        'en',
        item({
          type: 'monthly_report_ready',
          related: { type: 'monthly_report', id: 'm1', meta: { month: '2026-04' } },
        }),
      ),
    ).toBe('/en/app/reports/2026-04');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'employee_missing_checkout',
          related: {
            type: 'attendance_record',
            id: 'a1',
            meta: { date: '2026-05-05', employee_id: 'e1' },
          },
        }),
      ),
    ).toBe('/en/admin/attendance?date=2026-05-05');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'tasks_need_reassignment',
          related: { type: 'employee', id: 'e1' },
        }),
      ),
    ).toBe('/en/admin/tasks?assignee=e1');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'report_export_completed',
          related: { type: 'report_export', id: 'x1', meta: { report_key: 'attendance' } },
        }),
      ),
    ).toBe('/en/admin/reports/attendance');
  });

  it('a summary opens the list of its type', () => {
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'leave_request_submitted',
          is_summary: true,
          group_count: 5,
          related: { type: 'request', id: null },
        }),
      ),
    ).toBe('/en/admin/requests?category=leave');
    expect(
      notificationHref(
        'en',
        item({
          audience: 'admin',
          type: 'task_overdue',
          is_summary: true,
          related: { type: 'task', id: null },
        }),
      ),
    ).toBe('/en/admin/tasks?overdue=true');
  });

  it('a source that no longer exists goes nowhere', () => {
    expect(notificationHref('en', item({ related: { available: false } }))).toBeNull();
  });
});

describe('presentation', () => {
  it('reads the stored variant for the page language', () => {
    const notification = item({});
    expect(inLocale(notification.title, 'ar')).toBe('مهمة جديدة');
    expect(inLocale(notification.title, 'en')).toBe('New task');
  });

  it('caps the badge at 99+', () => {
    expect(badgeLabel(7, '99+')).toBe('7');
    expect(badgeLabel(99, '99+')).toBe('99');
    expect(badgeLabel(100, '99+')).toBe('99+');
  });

  it('groups by the company’s calendar day, not UTC’s', () => {
    const now = new Date('2026-05-10T08:00:00.000Z');
    const groups = groupByDay(
      [
        item({ id: 'a', created_at: '2026-05-10T07:00:00.000Z' }),
        // 22:30 UTC on the 9th is already the 10th in Cairo.
        item({ id: 'b', created_at: '2026-05-09T22:30:00.000Z' }),
        item({ id: 'c', created_at: '2026-05-09T10:00:00.000Z' }),
        item({ id: 'd', created_at: '2026-05-01T10:00:00.000Z' }),
      ],
      'Africa/Cairo',
      now,
    );
    expect(groups.map((g) => [g.day, g.relative, g.items.map((i) => i.id)])).toEqual([
      ['2026-05-10', 'today', ['a', 'b']],
      ['2026-05-09', 'yesterday', ['c']],
      ['2026-05-01', null, ['d']],
    ]);
  });
});

describe('the unread count — polled, never per render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('one fetch for many bells, then one every sixty seconds; a navigation refresh joins one in flight', async () => {
    let resolve: (value: number) => void = () => undefined;
    const fetchCount = vi.fn(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    const counter = new UnreadCounter(fetchCount);
    const seen: (number | null)[] = [];
    const stopA = counter.subscribe((count) => seen.push(count));
    const stopB = counter.subscribe(() => undefined);
    void counter.refresh();
    expect(fetchCount).toHaveBeenCalledTimes(1);
    resolve(4);
    await vi.waitFor(() => expect(seen).toContain(4));

    await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS);
    expect(fetchCount).toHaveBeenCalledTimes(2);
    resolve(5);
    await vi.waitFor(() => expect(seen).toContain(5));

    counter.set(0);
    expect(seen[seen.length - 1]).toBe(0);

    stopA();
    stopB();
    await vi.advanceTimersByTimeAsync(UNREAD_POLL_MS * 3);
    expect(fetchCount).toHaveBeenCalledTimes(2);
  });
});
