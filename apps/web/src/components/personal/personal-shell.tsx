'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { FreehandIcon } from '../freehand-icon';
import { LanguageSwitch } from '../language-switch';
import { SignOutButton } from '../sign-out-button';
import { loadSession } from '../employees/use-session';
import type { SessionView } from '../employees/use-session';
import { useResource } from '../settings/use-resource';
import { containDialogFocus } from '../../lib/dialog-focus';
import { languageNames } from '../../lib/language-names';
import {
  currentSection,
  PERSONAL_SECTIONS,
  personalHref,
  personalIcon,
  workspaceFor,
} from '../../lib/personal';
import type { PersonalSection } from '../../lib/personal';
import { publicPath } from '../../lib/public-content';
import { applyTheme, readStoredTheme, THEMES, themeLabelKey } from '../../lib/themes';
import type { Theme } from '../../lib/themes';

/**
 * The logo as the reference draws it: "1to1OS" in navy and "Personal" in
 * blue italic at the same size, the brush stroke under "Personal", no spark.
 */
function PersonalLogo(): React.JSX.Element {
  return (
    <span className="plogo" dir="ltr" translate="no">
      <span className="plogo__os">1to1OS</span>
      <span className="plogo__p">
        Personal
        <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
          <path d="M3 7C30 3.6 64 3 97 5" />
        </svg>
      </span>
    </span>
  );
}

/** The signed-in person, for the screens inside the shell. */
const PersonalSessionContext = createContext<SessionView | null>(null);

export function usePersonalSession(): SessionView | null {
  return useContext(PersonalSessionContext);
}

/** The reference drawing; decorative, since the label beside it names it. */
export function PersonalIcon({
  entry,
  size = 44,
}: {
  readonly entry: PersonalSection | 'home' | 'theme';
  readonly size?: number;
}): React.JSX.Element {
  return (
    <span className="pnav-icon" style={{ inlineSize: size, blockSize: size }} aria-hidden="true">
      <img src={personalIcon(entry)} alt="" width={size} height={size} decoding="async" />
    </span>
  );
}

/**
 * "Change theme" is the sidebar's last row, as in the reference design: it
 * opens the four themes right under it.
 */
function ThemeRow({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);
  return (
    <div className="pnav-theme">
      <button
        type="button"
        className="pnav-link"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <PersonalIcon entry="theme" size={42} />
        <span>{t('personal.nav.theme')}</span>
      </button>
      {open ? (
        <div className="pnav-themes" role="radiogroup" aria-label={t('theme.label')}>
          {THEMES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={candidate === theme}
              className="pnav-theme-option"
              onClick={() => {
                applyTheme(candidate);
                setTheme(candidate);
              }}
            >
              <span className={`theme-swatch theme-swatch--${candidate}`} aria-hidden="true" />
              <span>{t(themeLabelKey(candidate))}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Sidebar({
  locale,
  onNavigate,
}: {
  readonly locale: Locale;
  readonly onNavigate?: () => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const pathname = usePathname();
  const current = currentSection(locale, pathname);
  const entries: readonly (PersonalSection | 'home')[] = ['home', ...PERSONAL_SECTIONS];
  return (
    <nav className="pnav" aria-label={t('personal.nav_label')}>
      <ul className="pnav-list">
        {entries.map((entry) => (
          <li key={entry}>
            <Link
              href={personalHref(locale, entry)}
              className="pnav-link"
              aria-current={current === entry ? 'page' : undefined}
              {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
            >
              <PersonalIcon entry={entry} size={42} />
              <span>{t(`personal.nav.${entry}`)}</span>
            </Link>
          </li>
        ))}
        <li>
          <ThemeRow locale={locale} />
        </li>
      </ul>
    </nav>
  );
}

/**
 * The 1to1OS Personal workspace: the reference sidebar (logo, the eleven
 * sections, "Change theme") beside the screen, and on phones a top bar whose
 * menu opens the same sidebar as a drawer.
 *
 * It reads the session only to decide where the visitor belongs: signed out
 * goes to sign-in, a Business account to its own workspace. The API
 * authorises everything again.
 */
export function PersonalShell({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const drawer = useRef<HTMLDialogElement>(null);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  const ready = session.state.status === 'ready' ? session.state.value : null;
  const signedOut = session.state.status === 'error' && session.state.error.isUnauthenticated;
  const business = ready !== null && ready.roleKey !== 'personal';
  useEffect(() => {
    if (signedOut) router.replace(publicPath(locale, 'login'));
    else if (business) router.replace(workspaceFor(locale, ready.roleKey));
  }, [signedOut, business, ready, router, locale]);

  const close = (): void => {
    drawer.current?.close();
  };
  const brand = (
    <Link href={personalHref(locale, 'home')} className="pshell-brand" aria-label="1to1OS Personal">
      <PersonalLogo />
    </Link>
  );

  return (
    <PersonalSessionContext.Provider value={ready}>
      <div className="pshell">
        <a className="public-skip" href="#personal-content">
          {t('shell.skip')}
        </a>
        <aside className="pshell-side">
          <div className="pshell-card">
            {brand}
            <Sidebar locale={locale} />
          </div>
        </aside>
        <div className="pshell-main">
          <header className="pshell-top">
            <button
              type="button"
              className="icon-button pshell-menu"
              aria-label={t('personal.open_nav')}
              aria-haspopup="dialog"
              onClick={() => drawer.current?.showModal()}
            >
              <FreehandIcon name="menu" size={24} />
            </button>
            <span className="pshell-top__brand">{brand}</span>
            <div className="pshell-top__prefs">
              <LanguageSwitch
                locale={locale}
                label={t('language.switch')}
                names={languageNames(t)}
              />
              <SignOutButton locale={locale} />
            </div>
          </header>
          <main id="personal-content" tabIndex={-1} className="pshell-content">
            {children}
          </main>
        </div>
        <dialog
          ref={drawer}
          className="pshell-drawer"
          aria-label={t('personal.nav_label')}
          onKeyDown={containDialogFocus}
          onClick={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div className="pshell-card">
            <div className="pshell-drawer__head">
              {brand}
              <button
                type="button"
                className="icon-button"
                aria-label={t('personal.close_nav')}
                onClick={close}
              >
                <FreehandIcon name="close" size={22} />
              </button>
            </div>
            <Sidebar locale={locale} onNavigate={close} />
            <div className="pshell-drawer__out">
              <SignOutButton locale={locale} />
            </div>
          </div>
        </dialog>
      </div>
    </PersonalSessionContext.Provider>
  );
}
