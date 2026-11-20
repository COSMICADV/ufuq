'use client';

import { usePathname } from 'next/navigation';
import { LOCALES } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { pathInLocale } from '../lib/locale-route';

export interface LanguageSwitchProps {
  /** The locale currently rendered. */
  readonly locale: Locale;
  /** The switch's own label, already translated by the server. */
  readonly label: string;
  /** Each locale's name in its own language. */
  readonly names: Readonly<Record<Locale, string>>;
}

/**
 * The language switch: a small menu of the five languages.
 *
 * A `<details>` element, so it opens without JavaScript, and plain anchors rather
 * than client-side links on purpose. Changing the language changes `<html lang>`
 * and `<html dir>`, which live in the root layout, and only a document load
 * re-renders those. A full navigation also means the switch works with
 * JavaScript disabled, which DOCUMENT 23 requires of the public site.
 */
export function LanguageSwitch({ locale, label, names }: LanguageSwitchProps): React.JSX.Element {
  const pathname = usePathname();
  const current = pathname === '' || pathname === null ? `/${locale}` : pathname;

  return (
    <details className="lang-menu">
      <summary className="lang-menu__toggle" aria-label={`${label}: ${names[locale]}`}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="M3 12h18M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9S9.4 5.5 12 3Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        <span lang={locale}>{names[locale]}</span>
        <svg
          className="lang-menu__chevron"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="m6 9 6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <nav className="lang-menu__list" aria-label={label}>
        {LOCALES.map((candidate) =>
          candidate === locale ? (
            <span key={candidate} aria-current="true" lang={candidate}>
              {names[candidate]}
            </span>
          ) : (
            <a
              key={candidate}
              href={pathInLocale(current, candidate)}
              lang={candidate}
              hrefLang={candidate}
            >
              {names[candidate]}
            </a>
          ),
        )}
      </nav>
    </details>
  );
}
