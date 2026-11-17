'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { publicPath } from '../../lib/public-content';
import { BrandMark, Wordmark } from '../brand-mark';
import { loadSession } from '../employees/use-session';
import { LanguageSwitch } from '../language-switch';
import { useResource } from '../settings/use-resource';
import { SignOutButton } from '../sign-out-button';
import { ThemePicker } from '../theme-picker';

/** Who may use QR Studio: the company's owner and admins (the API checks the same roles). */
const STUDIO_ROLES = new Set(['super_admin', 'admin']);

/**
 * The frame QR Studio opens in: a 1to1OS page of its own (`/{locale}/qr`), outside the
 * business workspace — no workspace sidebar, just the 1to1OS header with QR Studio's
 * name, the way back to the workspace, the language switch, the theme picker and
 * sign-out. It is still part of 1to1OS: the same account, theme and design.
 *
 * Signed out, it goes to sign-in; an account that may not use QR Studio goes to its
 * own workspace.
 */
export function QrShell({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const ar = locale === 'ar';
  const router = useRouter();
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  const ready = session.state.status === 'ready' ? session.state.value : null;
  const signedOut = session.state.status === 'error' && session.state.error.isUnauthenticated;
  const notAllowed = ready !== null && !STUDIO_ROLES.has(ready.roleKey);
  const workspace = `/${locale}/${ready?.roleKey === 'employee' ? 'app' : 'admin'}`;

  useEffect(() => {
    if (signedOut) router.replace(publicPath(locale, 'login'));
    else if (notAllowed) router.replace(workspace);
  }, [signedOut, notAllowed, router, locale, workspace]);

  return (
    <div className="qr-shell">
      <a className="public-skip" href="#qr-content">
        {ar ? 'انتقل إلى المحتوى' : 'Skip to content'}
      </a>
      <header className="product-header qr-shell__header">
        <div className="app-topbar">
          <Link className="qr-shell__brand" href={`/${locale}/qr`}>
            <BrandMark />
            <span>
              <Wordmark />
              <small>{ar ? 'استوديو QR' : 'QR Studio'}</small>
            </span>
          </Link>
          <div className="app-topbar__actions">
            <Link className="button button--secondary qr-shell__back" href={workspace}>
              {ar ? 'مساحة العمل' : 'Workspace'}
            </Link>
            <LanguageSwitch
              locale={locale}
              label={t('language.switch')}
              names={{ ar: t('language.ar'), en: t('language.en') }}
            />
            <ThemePicker locale={locale} />
            <SignOutButton locale={locale} />
          </div>
        </div>
      </header>
      <div id="qr-content" tabIndex={-1} className="product-content qr-shell__content">
        {signedOut || notAllowed ? null : children}
      </div>
    </div>
  );
}
