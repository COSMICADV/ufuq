import Link from 'next/link';
import { createTranslator, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { FreehandIcon } from '../freehand-icon';
import { LanguageSwitch } from '../language-switch';
import { ThemePicker } from '../theme-picker';
import { PUBLIC_PAGES, publicPath } from '../../lib/public-content';

import { PublicForm } from './public-form';
import { BusinessArt, PersonalArt } from './product-art';

/**
 * Sign-in, redrawn in the 1to1OS design: the form on a white card, the two
 * approved hand-drawn doors beside it. The form itself is the same
 * `PublicForm` the old page used — same fields, same request, same errors —
 * so nothing about signing in changes, only how it looks.
 */
export function LoginScreen({
  locale,
  reset,
  employee,
}: {
  readonly locale: Locale;
  readonly reset: boolean;
  readonly employee: boolean;
}): React.JSX.Element {
  const c = publicCopy[locale];
  const t = createTranslator(locale);
  const login = PUBLIC_PAGES.indexOf('login');
  const forEmployee = employee && !reset;
  const title = reset ? c.forgot : forEmployee ? c.employeeTitle : c.titles[login];
  const body = reset ? c.resetInfo : forEmployee ? c.employeeBody : c.descriptions[login];

  return (
    <div className="os-auth">
      <a className="public-skip" href="#content">
        {c.skip}
      </a>
      <header className="os-auth__bar">
        <Link className="os-auth__home" href={publicPath(locale, 'home')} aria-label={c.brand}>
          <ProductLogo />
        </Link>
        <div className="os-auth__tools">
          <LanguageSwitch
            locale={locale}
            label={t('language.switch')}
            names={{ ar: t('language.ar'), en: t('language.en') }}
          />
          <ThemePicker locale={locale} />
        </div>
      </header>

      <main id="content" className="os-auth__main">
        <section className="os-auth__card" aria-labelledby="os-auth-title">
          <span className="os-auth__badge" aria-hidden="true">
            <FreehandIcon name={reset ? 'shield' : 'user'} size={28} />
          </span>
          <h1 id="os-auth-title">{title}</h1>
          <p className="os-auth__lead">{body}</p>
          <PublicForm
            key={`${locale}-login-${String(reset)}-${String(forEmployee)}`}
            locale={locale}
            kind={reset ? 'forgot' : 'login'}
            employee={forEmployee}
          />
        </section>

        <aside className="os-auth__art" aria-hidden="true">
          <p className="os-auth__headline">
            {t('entry.headlineStart')}
            {t('entry.headlineMark')}
            {t('entry.headlineJoin')}
            {t('entry.headlineEnd')}
          </p>
          <div className="os-auth__doors">
            <figure>
              <PersonalArt />
              <figcaption dir="ltr">
                1to1OS <em>Personal</em>
              </figcaption>
            </figure>
            <figure>
              <BusinessArt />
              <figcaption dir="ltr">
                1to1OS <em>Business</em>
              </figcaption>
            </figure>
          </div>
          <svg className="os-auth__waves" viewBox="0 0 600 120" preserveAspectRatio="none">
            <path d="M0 70C120 30 220 110 340 75S520 25 600 55V120H0Z" />
          </svg>
        </aside>
      </main>
    </div>
  );
}
