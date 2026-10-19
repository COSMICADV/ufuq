'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createTranslator, formatDate, formatTime } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { ApiError } from '../../lib/api-client';
import {
  groupByDay,
  inLocale,
  loadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationHref,
  unreadCounter,
} from '../../lib/notifications';
import type { NotificationItem } from '../../lib/notifications';
import { Alert, Badge, Button, EmptyState } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState } from '../settings/screen-states';

/**
 * The notification centre — DOCUMENT 04 C14 (`/app/notifications`) and the
 * same centre on the admin side (`/admin/notifications`), DOCUMENT 19
 * "Mobile behaviour", DOCUMENT 11 §7.
 *
 *   - Grouped by day in the **company's** timezone; unread items emphasised
 *     (weight, a dot and an "Unread" label for screen readers — never colour
 *     alone).
 *   - Tapping an item marks it read and opens its source. A source that no
 *     longer exists says "no longer available" and goes nowhere.
 *   - A summary (DOCUMENT 19 rule 4) shows its count and opens the list.
 *   - "Handled" marks an approval another approver already decided.
 *   - Mark one read, mark all read, load more, refresh — and pull to refresh
 *     on a touch screen.
 *   - Loading, empty, error (with retry) and ready states (DOCUMENT 11 §2).
 *
 * Every read is the caller's own: the API has no way to ask for anyone else's.
 */

type Feed =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | {
      readonly status: 'ready';
      readonly items: readonly NotificationItem[];
      readonly page: number;
      readonly totalPages: number;
    };

const PULL_THRESHOLD_PX = 70;

function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(0, null);
}

export function NotificationCenter({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const counter = unreadCounter(locale);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [feed, setFeed] = useState<Feed>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [unavailableId, setUnavailableId] = useState<string | null>(null);
  const [pull, setPull] = useState(0);
  const pullStart = useRef<number | null>(null);
  const generation = useRef(0);
  const knownZone = useRef<string | null>(null);

  const loadFirst = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const run = ++generation.current;
      if (mode === 'initial') setFeed({ status: 'loading' });
      else setRefreshing(true);
      try {
        const [session, page] = await Promise.all([
          knownZone.current === null ? loadSession(locale, new AbortController().signal) : null,
          loadNotifications(locale, 1, unreadOnly),
        ]);
        if (run !== generation.current) return;
        if (session !== null) {
          knownZone.current = session.timeZone;
          setTimeZone(session.timeZone);
        }
        setFeed({ status: 'ready', items: page.items, page: 1, totalPages: page.meta.total_pages });
        // The bell fetched the count when the page loaded; only a refresh
        // asked for here needs a new one.
        if (mode === 'refresh') void counter.refresh();
      } catch (error) {
        if (run !== generation.current) return;
        if (mode === 'initial') setFeed({ status: 'error', error: asApiError(error) });
        else setActionError(true);
      } finally {
        if (run === generation.current) setRefreshing(false);
      }
    },
    [locale, unreadOnly, counter],
  );

  // The first load, and again whenever the filter changes.
  useEffect(() => {
    void loadFirst('initial');
  }, [loadFirst]);

  const loadMore = async (): Promise<void> => {
    if (feed.status !== 'ready' || feed.page >= feed.totalPages) return;
    setLoadingMore(true);
    try {
      const next = await loadNotifications(locale, feed.page + 1, unreadOnly);
      setFeed((current) =>
        current.status !== 'ready'
          ? current
          : {
              status: 'ready',
              // A notification can arrive between pages; never list one twice.
              items: [
                ...current.items,
                ...next.items.filter((item) => !current.items.some((seen) => seen.id === item.id)),
              ],
              page: current.page + 1,
              totalPages: next.meta.total_pages,
            },
      );
    } catch {
      setActionError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const replaceItem = (updated: NotificationItem): void => {
    setFeed((current) =>
      current.status !== 'ready'
        ? current
        : {
            ...current,
            items: current.items.map((item) => (item.id === updated.id ? updated : item)),
          },
    );
  };

  const markRead = async (item: NotificationItem): Promise<boolean> => {
    if (item.read_at !== null) return true;
    try {
      replaceItem(await markNotificationRead(locale, item.id));
      void counter.refresh();
      return true;
    } catch {
      setActionError(true);
      return false;
    }
  };

  const open = async (item: NotificationItem): Promise<void> => {
    setActionError(false);
    const href = notificationHref(locale, item);
    await markRead(item);
    if (href === null) {
      setUnavailableId(item.id);
      return;
    }
    router.push(href);
  };

  const markAll = async (): Promise<void> => {
    setBusyAll(true);
    setActionError(false);
    try {
      await markAllNotificationsRead(locale);
      const now = new Date().toISOString();
      setFeed((current) =>
        current.status !== 'ready'
          ? current
          : {
              ...current,
              items: unreadOnly
                ? []
                : current.items.map((item) =>
                    item.read_at === null ? { ...item, read_at: now } : item,
                  ),
            },
      );
      counter.set(0);
    } catch {
      setActionError(true);
    } finally {
      setBusyAll(false);
    }
  };

  // Pull to refresh — only from the very top of the page, only by touch.
  const onTouchStart = (event: React.TouchEvent): void => {
    pullStart.current = window.scrollY <= 0 ? (event.touches[0]?.clientY ?? null) : null;
  };
  const onTouchMove = (event: React.TouchEvent): void => {
    if (pullStart.current === null) return;
    const distance = (event.touches[0]?.clientY ?? 0) - pullStart.current;
    setPull(Math.max(0, Math.min(distance, PULL_THRESHOLD_PX * 1.5)));
  };
  const onTouchEnd = (): void => {
    if (pullStart.current !== null && pull >= PULL_THRESHOLD_PX) void loadFirst('refresh');
    pullStart.current = null;
    setPull(0);
  };

  const hasUnread = feed.status === 'ready' && feed.items.some((item) => item.read_at === null);

  return (
    <div className="tasks-page notification-center">
      <header className="page-heading">
        <div>
          <h1>{t('notifications.ui.title')}</h1>
          <p>{t('notifications.ui.description')}</p>
        </div>
        <div className="button-row notification-center__actions">
          <Button
            variant="secondary"
            size="md"
            onClick={() => void loadFirst('refresh')}
            loading={refreshing}
            disabled={feed.status === 'loading'}
          >
            {t('notifications.ui.refresh')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => void markAll()}
            loading={busyAll}
            disabled={!hasUnread}
          >
            {t('notifications.ui.mark_all_read')}
          </Button>
        </div>
      </header>

      <main
        className="tasks-page__content"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="notification-pull"
          aria-hidden={pull === 0 && !refreshing}
          style={{ blockSize: refreshing ? 32 : pull / 2 }}
        >
          {refreshing
            ? t('notifications.ui.refreshing')
            : pull > 0
              ? pull >= PULL_THRESHOLD_PX
                ? t('notifications.ui.release_to_refresh')
                : t('notifications.ui.pull_to_refresh')
              : null}
        </div>

        <div
          className="notification-filter"
          role="group"
          aria-label={t('notifications.ui.filter_label')}
        >
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              className={unreadOnly === value ? 'is-active' : ''}
              aria-pressed={unreadOnly === value}
              onClick={() => setUnreadOnly(value)}
            >
              {value ? t('notifications.ui.filter_unread') : t('notifications.ui.filter_all')}
            </button>
          ))}
        </div>

        <div role="status" aria-live="polite" className="state-live">
          {actionError ? (
            <Alert tone="danger" title={t('notifications.ui.action_failed')}>
              {t('state.error_detail')}
            </Alert>
          ) : null}
        </div>

        {feed.status === 'loading' ? (
          <LoadingState t={t} rows={6} />
        ) : feed.status === 'error' ? (
          <ErrorState error={feed.error} t={t} onRetry={() => void loadFirst('initial')} />
        ) : feed.items.length === 0 ? (
          <EmptyState
            title={
              unreadOnly ? t('notifications.ui.empty_unread') : t('notifications.ui.empty_title')
            }
            description={t('notifications.ui.empty_body')}
            action={null}
          />
        ) : (
          <>
            {groupByDay(feed.items, timeZone ?? 'UTC').map((group) => (
              <section
                key={group.day}
                className="notification-day"
                aria-labelledby={`day-${group.day}`}
              >
                <h2 id={`day-${group.day}`}>
                  {group.relative === 'today'
                    ? t('notifications.ui.today')
                    : group.relative === 'yesterday'
                      ? t('notifications.ui.yesterday')
                      : formatDate(new Date(group.items[0]?.created_at ?? group.day), {
                          locale,
                          timeZone: timeZone ?? 'UTC',
                        })}
                </h2>
                <ul className="notification-list">
                  {group.items.map((item) => (
                    <NotificationRow
                      key={item.id}
                      item={item}
                      locale={locale}
                      t={t}
                      timeZone={timeZone ?? 'UTC'}
                      unavailable={unavailableId === item.id || !item.related.available}
                      onOpen={() => void open(item)}
                      onMarkRead={() => void markRead(item)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {feed.page < feed.totalPages ? (
              <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
                {t('notifications.ui.load_more')}
              </Button>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One notification. Its text is the stored variant in the page's language,
 * so it takes the page's direction; `dir="auto"` would lay an English
 * sentence that starts with an Arabic name out right-to-left.
 */
function NotificationRow({
  item,
  locale,
  t,
  timeZone,
  unavailable,
  onOpen,
  onMarkRead,
}: {
  readonly item: NotificationItem;
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly unavailable: boolean;
  readonly onOpen: () => void;
  readonly onMarkRead: () => void;
}): React.JSX.Element {
  const unread = item.read_at === null;
  return (
    <li
      className={`notification-item${unread ? ' is-unread' : ''}${unavailable ? ' is-unavailable' : ''}`}
    >
      <button type="button" className="notification-item__open" onClick={onOpen}>
        <span className="notification-item__dot" aria-hidden="true" />
        <span className="notification-item__text">
          <span className="notification-item__title">
            {inLocale(item.title, locale)}
            {unread ? (
              <span className="visually-hidden"> — {t('notifications.ui.unread')}</span>
            ) : null}
          </span>
          <span className="notification-item__body">{inLocale(item.body, locale)}</span>
          <span className="notification-item__meta">
            <time dateTime={item.created_at}>
              {formatTime(new Date(item.created_at), { locale, timeZone })}
            </time>
            {item.priority === 'high' ? (
              <Badge tone="warning">{t('notifications.ui.priority.high')}</Badge>
            ) : null}
            {item.is_summary ? (
              <Badge tone="info">
                {t('notifications.ui.summary_count', { count: String(item.group_count) })}
              </Badge>
            ) : null}
            {item.handled_at !== null ? (
              <Badge tone="success">{t('notifications.ui.handled')}</Badge>
            ) : null}
            {unavailable ? (
              <Badge tone="cancelled">{t('notifications.ui.unavailable')}</Badge>
            ) : null}
          </span>
        </span>
      </button>
      {unread ? (
        <Button variant="ghost" size="sm" onClick={onMarkRead} className="notification-item__read">
          {t('notifications.ui.mark_read')}
        </Button>
      ) : null}
    </li>
  );
}
