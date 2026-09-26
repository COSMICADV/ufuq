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
 * The language switch.
 *
 * It renders plain anchors rather than client-side links on purpose. Changing
 * the language changes `<html lang>` and `<html dir>`, which live in the root
 * layout, and only a document load re-renders those. A full navigation also
 * means the switch works with JavaScript disabled, which DOCUMENT 23 requires
 * of the public site.
 */
export function LanguageSwitch({ locale, label, names }: LanguageSwitchProps): React.JSX.Element {
  const pathname = usePathname();
  const current = pathname === '' || pathname === null ? `/${locale}` : pathname;

  return (
    <nav className="language-switch" aria-label={label}>
      {LOCALES.map((candidate) =>
        candidate === locale ? (
          <span key={candidate} aria-current="true" lang={candidate}>
            {names[candidate]}
          </span>
        ) : (
          <a key={candidate} href={pathInLocale(current, candidate)} lang={candidate}>
            {names[candidate]}
          </a>
        ),
      )}
    </nav>
  );
}
