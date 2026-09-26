import Link from 'next/link';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import type { ReactNode } from 'react';

import { sectionLabelKey, SETTINGS_SECTIONS, settingsPath } from '../../lib/settings-nav';
import type { SettingsSection } from '../../lib/settings-nav';

/**
 * The frame every settings screen sits in — DOCUMENT 03 §7's page skeleton
 * (title + breadcrumb, then the screen's own content) and §6's breadcrumb rule
 * ("breadcrumbs appear on all pages below the top level").
 *
 * A server component: it renders text that never changes after load, so it
 * carries no JavaScript to the browser.
 *
 * The first breadcrumb is plain text rather than a link. DOCUMENT 03 §3's
 * route tree gives `/settings` children but no screen of its own, and a
 * breadcrumb that navigates somewhere that does not exist is worse than one
 * that does not navigate.
 *
 * The section list is a `<nav>` of links, not the eleven-item product sidebar
 * from DOCUMENT 03 §2: ten of those eleven screens belong to later phases, and
 * linking to them now would be the "coming soon" panel DOCUMENT 27 RULE 26
 * forbids. Direction is never set here — `dir` lives on `<html>` (DOCUMENT 10
 * §9.2) and the layout is written in logical properties, so the nav lands on
 * the correct side by itself.
 */
export function SettingsShell({
  locale,
  section,
  children,
}: {
  readonly locale: Locale;
  readonly section: SettingsSection;
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);

  return (
    <div className="settings">
      <nav className="settings__breadcrumb" aria-label={t('settings.breadcrumb')}>
        <ol>
          <li>{t('settings.breadcrumb')}</li>
          <li aria-current="page">{t(sectionLabelKey(section))}</li>
        </ol>
      </nav>

      <div className="settings__body">
        <nav className="settings__sections" aria-label={t('settings.section_label')}>
          {SETTINGS_SECTIONS.map((candidate) => (
            <Link
              key={candidate}
              href={settingsPath(locale, candidate)}
              className={candidate === section ? 'is-active' : ''}
              {...(candidate === section ? { 'aria-current': 'page' as const } : {})}
            >
              {t(sectionLabelKey(candidate))}
            </Link>
          ))}
        </nav>

        <main className="settings__content">{children}</main>
      </div>
    </div>
  );
}

/**
 * A screen's heading and one-line explanation. Separate from the shell so the
 * schedules screen — which holds two collections — states what it is once
 * rather than once per card.
 */
export function SettingsHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): React.JSX.Element {
  return (
    <header className="settings__heading">
      <h1>{title}</h1>
      <p>{description}</p>
    </header>
  );
}
