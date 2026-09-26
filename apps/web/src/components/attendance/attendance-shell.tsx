import Link from 'next/link';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

/**
 * The frame the attendance screens sit in — DOCUMENT 03 §7's page skeleton.
 *
 * Like the Phase 4 and Phase 5 frames, this is not the eleven-item product
 * sidebar from DOCUMENT 03 §2: most of those modules belong to later phases,
 * and linking to them now would be a "coming soon" panel by another name
 * (DOCUMENT 27 RULE 26). The tabs below link only to screens that exist.
 */

export function AttendanceShell({
  locale,
  active,
  children,
}: {
  readonly locale: Locale;
  readonly active: 'board' | 'monthly' | 'corrections' | 'me' | 'history';
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const admin = active === 'board' || active === 'monthly' || active === 'corrections';

  const tabs = admin
    ? [
        { key: 'board', href: `/${locale}/admin/attendance`, label: t('attendance.board_title') },
        {
          key: 'monthly',
          href: `/${locale}/admin/attendance/monthly`,
          label: t('attendance.monthly_title'),
        },
        {
          key: 'corrections',
          href: `/${locale}/admin/attendance/corrections`,
          label: t('attendance.corrections_title'),
        },
      ]
    : [
        { key: 'me', href: `/${locale}/app/attendance`, label: t('attendance.my_title') },
        {
          key: 'history',
          href: `/${locale}/app/attendance/history`,
          label: t('attendance.history_title'),
        },
      ];

  return (
    <div className="attendance-page">
      <header className="page-heading">
        <div>
          <h1>{t('attendance.title')}</h1>
        </div>
      </header>
      <nav className="attendance-tabs" aria-label={t('attendance.title')}>
        <ul>
          {tabs.map((tab) => (
            <li key={tab.key}>
              <Link
                href={tab.href}
                aria-current={tab.key === active ? 'page' : undefined}
                className={tab.key === active ? 'is-active' : ''}
              >
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="attendance-page__content">{children}</main>
    </div>
  );
}
