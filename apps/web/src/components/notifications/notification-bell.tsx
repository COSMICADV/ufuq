'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { badgeLabel, notificationsPath, unreadCounter } from '../../lib/notifications';

/**
 * The bell — DOCUMENT 19 "Mobile behaviour" ("bell with unread dot in the
 * header"), DOCUMENT 11 §7 ("unread count on the bell, capped at 99+";
 * "badge counts refresh on navigation and on a polling interval, not on
 * every keystroke").
 *
 * The count comes from the page's one shared {@link unreadCounter}: fetched
 * when the shell mounts, again on each navigation (a new pathname), and every
 * sixty seconds while a bell is on the page — never per render.
 */
export function NotificationBell({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const [count, setCount] = useState<number | null>(null);
  const counter = unreadCounter(locale);

  useEffect(() => counter.subscribe(setCount), [counter]);
  useEffect(() => {
    void counter.refresh();
  }, [counter, pathname]);

  const unread = count ?? 0;
  const label =
    unread > 0
      ? t('notifications.ui.bell_unread', { count: String(unread) })
      : t('notifications.ui.bell');
  return (
    <Link
      className={`notification-bell${unread > 0 ? ' has-unread' : ''}`}
      href={notificationsPath(locale, surface)}
      aria-label={label}
      title={label}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22">
        <path
          d="M12 3a6 6 0 0 0-6 6v3.6l-1.6 2.7A1 1 0 0 0 5.3 17h13.4a1 1 0 0 0 .9-1.7L18 12.6V9a6 6 0 0 0-6-6Zm0 18a2.5 2.5 0 0 0 2.4-2h-4.8A2.5 2.5 0 0 0 12 21Z"
          fill="currentColor"
        />
      </svg>
      {unread > 0 ? (
        <span className="notification-bell__badge" aria-hidden="true">
          {badgeLabel(unread, t('notifications.ui.overflow'))}
        </span>
      ) : null}
    </Link>
  );
}
