import Link from 'next/link';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { LanguageSwitch } from '../language-switch';
import { SignOutButton } from '../sign-out-button';
import { ThemePicker } from '../theme-picker';

import { NotificationBell } from './notification-bell';

/**
 * The header strip the admin and employee sides share — DOCUMENT 03 §5
 * ("Notifications bell: header — Admin, Employee"). It holds only what V1
 * has to offer on every screen: the way home, the language switch and the
 * bell. The product's full navigation arrives with the redesign; this is not
 * that navigation.
 *
 * Rendered by each side's layout, so it persists across navigations and the
 * unread count is polled by one bell, not one per page.
 */
export function AppTopbar({
  locale,
  surface,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="app-topbar">
      <Link className="app-topbar__home" href={`/${locale}/${surface}`} aria-label={t('app.name')}>
        <ProductLogo product="Business" />
      </Link>
      <div className="app-topbar__actions">
        <div className="app-topbar__prefs">
          <LanguageSwitch
            locale={locale}
            label={t('language.switch')}
            names={{ ar: t('language.ar'), en: t('language.en') }}
          />
          <ThemePicker locale={locale} />
        </div>
        <NotificationBell locale={locale} surface={surface} />
        <div className="app-topbar__prefs">
          <SignOutButton locale={locale} />
        </div>
      </div>
    </div>
  );
}
