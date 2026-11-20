import Link from 'next/link';
import type { Metadata } from 'next';
import { createTranslator, LOCALES } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { PUBLIC_PAGES, publicCopy, publicPath } from '../../lib/public-content';
import type { PublicPage } from '../../lib/public-content';
import { ProductLogo } from '../brand-mark';
import { LanguageSwitch } from '../language-switch';
import { languageNames } from '../../lib/language-names';
import { ThemePicker } from '../theme-picker';
import { PublicForm } from './public-form';

const OG_LOCALE: Record<Locale, string> = {
  ar: 'ar_EG',
  en: 'en_US',
  fr: 'fr_FR',
  it: 'it_IT',
  de: 'de_DE',
};

export function publicMetadata(locale: Locale, page: PublicPage): Metadata {
  const c = publicCopy[locale];
  const i = PUBLIC_PAGES.indexOf(page);
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const url = new URL(publicPath(locale, page), origin).href;
  return {
    metadataBase: new URL(origin),
    title: `${c.nav[i]} | ${c.brand}`,
    description: c.descriptions[i],
    alternates: {
      canonical: url,
      languages: {
        ...Object.fromEntries(LOCALES.map((l) => [l, publicPath(l, page)])),
        'x-default': '/',
      },
    },
    openGraph: {
      type: 'website',
      title: c.titles[i],
      description: c.descriptions[i],
      url,
      locale: OG_LOCALE[locale],
      alternateLocale: LOCALES.filter((l) => l !== locale).map((l) => OG_LOCALE[l]),
      siteName: c.brand,
    },
    ...(page === 'login' || page === 'register' ? { robots: { index: false, follow: true } } : {}),
  };
}
export function PublicSite({
  locale,
  page,
  reset = false,
  employee = false,
}: {
  readonly locale: Locale;
  readonly page: PublicPage;
  readonly reset?: boolean;
  /** The sign-in page opened from "Employee sign in": same form, wording for employees. */
  readonly employee?: boolean;
}): React.JSX.Element {
  const forEmployee = employee && page === 'login' && !reset;
  const c = publicCopy[locale];
  const t = createTranslator(locale);
  const index = PUBLIC_PAGES.indexOf(page);
  return (
    <div className={`public-site public-site--${page}`}>
      <a className="public-skip" href="#content">
        {c.skip}
      </a>
      {/* Inside the product's front door there is nothing to browse: the logo
          leads back to the product choice, and the header holds only the
          language and theme. */}
      <header className="public-header">
        <Link className="os-auth__home" href={publicPath(locale, 'home')} aria-label={c.brand}>
          <ProductLogo />
        </Link>
        <div className="public-account">
          <LanguageSwitch locale={locale} label={t('language.switch')} names={languageNames(t)} />
          <ThemePicker locale={locale} />
        </div>
      </header>
      <main id="content">
        <section className="public-intro">
          <div className="public-wrap">
            <p className="public-eyebrow">{page === 'for-individuals' ? c.coming : c.brand}</p>
            <h1>{reset ? c.forgot : forEmployee ? c.employeeTitle : c.titles[index]}</h1>
            <p>{reset ? c.resetInfo : forEmployee ? c.employeeBody : c.descriptions[index]}</p>
          </div>
        </section>
        <div className="public-wrap public-sections">
          {page === 'for-individuals' ? (
            <section>
              <h2>{c.companies}</h2>
              <Link
                className="button button--primary button--lg"
                href={publicPath(locale, 'login')}
              >
                1to1OS Business
              </Link>
            </section>
          ) : null}
          {page === 'contact' || page === 'register' || page === 'login' ? (
            <section className="public-form-panel">
              <PublicForm
                key={`${locale}-${page}-${String(reset)}-${String(forEmployee)}`}
                locale={locale}
                kind={page === 'login' && reset ? 'forgot' : page}
                employee={forEmployee}
              />
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
