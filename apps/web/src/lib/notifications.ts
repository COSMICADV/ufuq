/**
 * Notifications on the web — DOCUMENT 19 "Mobile behaviour" and "API
 * requirements", DOCUMENT 04 C14, DOCUMENT 11 §7.
 *
 * Nothing here decides who is told or what a notification says: the API
 * stores both languages and this file picks the one the page is rendered in
 * (so history follows a language change). What it owns is where a
 * notification **goes** (`notificationHref`), how the feed is grouped by day
 * (in the company's timezone, never the browser's), and the one unread-count
 * poller every bell shares.
 */

import type { Locale } from '@ufuq/i18n';

import { fetchMany, fetchOne } from './api-client';
import type { CollectionResult } from './api-client';

export type NotificationAudience = 'admin' | 'employee';
export type NotificationPriority = 'high' | 'medium' | 'low';

export interface NotificationItem {
  readonly id: string;
  readonly type: string;
  readonly priority: NotificationPriority;
  readonly audience: NotificationAudience;
  readonly title: { readonly ar: string; readonly en: string };
  readonly body: { readonly ar: string; readonly en: string };
  readonly related: {
    readonly type: string;
    /** Null for a summary: it opens the list of its type. */
    readonly id: string | null;
    readonly available: boolean;
    readonly meta: Readonly<Record<string, string>> | null;
  };
  readonly group_count: number;
  readonly is_summary: boolean;
  readonly read_at: string | null;
  readonly handled_at: string | null;
  readonly created_at: string;
}

/** The API's bound on a page. */
export const FEED_PAGE_SIZE = 20;
/** DOCUMENT 19: "polled on navigation and on an interval (default 60s)". */
export const UNREAD_POLL_MS = 60_000;
/** DOCUMENT 11 §7: "Unread count on the bell, capped at 99+". */
export const BADGE_CAP = 99;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export function loadNotifications(
  locale: Locale,
  page: number,
  unreadOnly: boolean,
  signal?: AbortSignal,
): Promise<CollectionResult<NotificationItem>> {
  return fetchMany<NotificationItem>('/notifications', {
    locale,
    query: {
      page: String(page),
      per_page: String(FEED_PAGE_SIZE),
      ...(unreadOnly ? { unread: 'true' } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

export async function loadUnreadCount(locale: Locale, signal?: AbortSignal): Promise<number> {
  const data = await fetchOne<{ count: number }>('/notifications/unread-count', {
    locale,
    ...(signal ? { signal } : {}),
  });
  return data.count;
}

export function markNotificationRead(locale: Locale, id: string): Promise<NotificationItem> {
  return fetchOne<NotificationItem>(`/notifications/${id}/read`, { locale, method: 'POST' });
}

export function markAllNotificationsRead(locale: Locale): Promise<{ updated: number }> {
  return fetchOne<{ updated: number }>('/notifications/read-all', { locale, method: 'POST' });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** The stored variant for the page's language — both are always there. */
export function inLocale(
  text: { readonly ar: string; readonly en: string },
  locale: Locale,
): string {
  return locale === 'ar' ? text.ar : text.en;
}

export function badgeLabel(count: number, overflow: string): string {
  return count > BADGE_CAP ? overflow : String(count);
}

/** The surface a notification belongs to: the admin side or the employee's. */
export function notificationsPath(locale: string, surface: 'admin' | 'app'): string {
  return `/${locale}/${surface}/notifications`;
}

const SUMMARY_REQUEST_CATEGORY: Readonly<Record<string, string>> = {
  leave_request_submitted: 'leave',
  attendance_correction_submitted: 'attendance',
};

/**
 * Where tapping a notification goes (DOCUMENT 19 rule 5). The audience picks
 * the side: an admin or manager notification opens the admin screen, an
 * employee's opens their own. Null when the source no longer exists — the
 * item then renders "no longer available" instead of a broken link (DOCUMENT
 * 19 "Error states").
 */
export function notificationHref(locale: string, item: NotificationItem): string | null {
  const { related } = item;
  if (!related.available) return null;
  const admin = item.audience === 'admin';
  const side = admin ? 'admin' : 'app';
  const base = `/${locale}/${side}`;
  const id = related.id;

  switch (related.type) {
    case 'request': {
      if (id !== null) return `${base}/requests/${id}`;
      const category = SUMMARY_REQUEST_CATEGORY[item.type];
      return category === undefined ? `${base}/requests` : `${base}/requests?category=${category}`;
    }
    case 'task':
      if (id !== null) return `${base}/tasks/${id}`;
      return admin && item.type === 'task_overdue' ? `${base}/tasks?overdue=true` : `${base}/tasks`;
    case 'goal':
      return id === null ? `${base}/goals` : `${base}/goals/${id}`;
    case 'product':
      return id === null ? `/${locale}/admin/inventory` : `/${locale}/admin/inventory/${id}`;
    case 'payroll_period':
      if (admin) return id === null ? `${base}/payroll` : `${base}/payroll/${id}`;
      return id === null ? `${base}/salary/history` : `${base}/salary/${id}`;
    case 'attendance_record': {
      const date = related.meta?.['date'];
      if (admin) {
        return date === undefined ? `${base}/attendance` : `${base}/attendance?date=${date}`;
      }
      return `${base}/attendance/history`;
    }
    case 'employee':
      return id === null ? `/${locale}/admin/tasks` : `/${locale}/admin/tasks?assignee=${id}`;
    case 'monthly_report': {
      const month = related.meta?.['month'];
      return month === undefined ? `/${locale}/app/reports` : `/${locale}/app/reports/${month}`;
    }
    case 'report_export': {
      const key = related.meta?.['report_key'];
      return key === undefined ? `/${locale}/admin/reports` : `/${locale}/admin/reports/${key}`;
    }
    default:
      return null;
  }
}

/** `YYYY-MM-DD` of an instant in the company's timezone (DOCUMENT 11 §9). */
export function dayIn(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export interface DayGroup<T> {
  readonly day: string;
  /** `today`, `yesterday`, or null for an older day (shown as a date). */
  readonly relative: 'today' | 'yesterday' | null;
  readonly items: readonly T[];
}

/**
 * DOCUMENT 19: "The notification list is grouped by day". The feed is already
 * newest first; this cuts it at each company-calendar day.
 */
export function groupByDay<T extends Pick<NotificationItem, 'created_at'>>(
  items: readonly T[],
  timeZone: string,
  now: Date = new Date(),
): DayGroup<T>[] {
  const today = dayIn(now.toISOString(), timeZone);
  const yesterday = shiftDay(today, -1);
  const groups: { day: string; relative: DayGroup<T>['relative']; items: T[] }[] = [];
  for (const item of items) {
    const day = dayIn(item.created_at, timeZone);
    let group = groups[groups.length - 1];
    if (group === undefined || group.day !== day) {
      group = {
        day,
        relative: day === today ? 'today' : day === yesterday ? 'yesterday' : null,
        items: [],
      };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// The unread count — one poller for the whole page
// ---------------------------------------------------------------------------

type Listener = (count: number | null) => void;

/**
 * The unread count every bell shows, fetched **once** however many bells are
 * mounted: on the shell's load, on each navigation (`refresh`), on an
 * interval of {@link UNREAD_POLL_MS}, and after the user reads something.
 * Never on a render. The interval runs only while someone is listening.
 */
export class UnreadCounter {
  private count: number | null = null;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly fetchCount: () => Promise<number>,
    private readonly intervalMs: number = UNREAD_POLL_MS,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.count);
    if (this.timer === null) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  /** Fetch now; a call while one is in flight joins it rather than adding another. */
  refresh(): Promise<void> {
    this.inFlight ??= this.fetchCount()
      .then((count) => this.set(count))
      .catch(() => {
        // A failed poll leaves the last known count; the next poll retries.
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  set(count: number): void {
    this.count = count;
    for (const listener of this.listeners) listener(count);
  }
}

const counters = new Map<Locale, UnreadCounter>();

/** The page's shared counter. */
export function unreadCounter(locale: Locale): UnreadCounter {
  let counter = counters.get(locale);
  if (counter === undefined) {
    counter = new UnreadCounter(() => loadUnreadCount(locale));
    counters.set(locale, counter);
  }
  return counter;
}
