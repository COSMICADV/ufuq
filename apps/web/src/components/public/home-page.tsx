import { createTranslator, getDirection, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { FreehandIcon } from '../freehand-icon';
import { LanguageSwitch } from '../language-switch';
import { languageNames } from '../../lib/language-names';
import { ThemePicker } from '../theme-picker';
import { publicPath } from '../../lib/public-content';
import { personalStart } from '../../lib/personal';

/**
 * The product choice, the second screen of 1to1OS: after the visitor picks a
 * language on the first screen (`/`), this page shows one headline and two
 * doors, Personal and Business. Nothing else is outside the product: no feature
 * list, no prices, no footer. Business opens sign-in (plans and prices live
 * inside the app); Personal opens its own page.
 *
 * Every word comes from the i18n catalogue (`entry.*`), so all five languages
 * share this one component.
 */

/** Where each door leads. */
export function homePaths(locale: Locale): {
  readonly home: string;
  readonly business: string;
  readonly personal: string;
  readonly login: string;
  readonly register: string;
} {
  const login = publicPath(locale, 'login');
  return {
    home: publicPath(locale, 'home'),
    // Straight into the product: sign-in, with sign-up one link away.
    business: login,
    personal: personalStart(locale),
    login,
    register: publicPath(locale, 'register'),
  };
}

function Brush(): React.JSX.Element {
  return (
    <svg
      className="home-door__brush"
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M3 6.6C30 3.2 66 2.8 97 4.8" />
    </svg>
  );
}

function Door({
  href,
  product,
  label,
}: {
  readonly href: string;
  readonly product: 'Business' | 'Personal';
  readonly label: string;
}): React.JSX.Element {
  return (
    <a className={`home-door home-door--${product.toLowerCase()}`} href={href} aria-label={label}>
      <span className="home-door__art">
        {/* The approved hand-drawn illustration of each product. */}
        <img
          src={`/brand/${product.toLowerCase()}.webp`}
          alt=""
          width={product === 'Business' ? 359 : 344}
          height={product === 'Business' ? 323 : 299}
          decoding="async"
          fetchPriority="high"
        />
      </span>
      <span className="home-door__name" dir="ltr" lang="en">
        <span className="home-door__brand">1to1OS</span>{' '}
        <span className="home-door__product">
          {product}
          <Brush />
        </span>
      </span>
      <span className="home-door__go" aria-hidden="true">
        <FreehandIcon name="chevron" size={22} />
      </span>
    </a>
  );
}

export function HomePage({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const paths = homePaths(locale);

  return (
    <div className="home" dir={getDirection(locale)}>
      <a className="public-skip" href="#content">
        {publicCopy[locale].skip}
      </a>

      <header className="home-header">
        <div className="home-header__inner">
          <a className="home-logo" href="/" aria-label={`1to1OS — ${t('entry.languages')}`}>
            <ProductLogo domain className="home-logo__wide" />
            {/* Phones: the larger, centred logo of the mobile design. */}
            <span className="home-mlogo" dir="ltr" translate="no" aria-hidden="true">
              <span className="home-mlogo__one">1</span>
              <span className="home-mlogo__rest">to</span>
              <span className="home-mlogo__one">1</span>
              <span className="home-mlogo__rest">OS</span>
              <span className="home-mlogo__com">.COM</span>
              <svg viewBox="0 0 100 10" preserveAspectRatio="none">
                <path d="M3 7C30 3.6 64 3 97 5" />
              </svg>
            </span>
          </a>
          <div className="home-header__tools">
            <LanguageSwitch locale={locale} label={t('language.switch')} names={languageNames(t)} />
            <ThemePicker locale={locale} />
          </div>
        </div>
      </header>

      <main id="content">
        <section className="home-hero home-hero--only" aria-labelledby="home-title">
          <h1 id="home-title" className="home-title">
            {t('entry.headlineStart')}
            <span className="home-title__keep">
              {t('entry.headlineMark')}
              {t('entry.headlineJoin')}
            </span>
            <span className="home-title__end">{t('entry.headlineEnd')}</span>
          </h1>
          <svg
            className="home-title__brush"
            viewBox="0 0 100 10"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path d="M3 6.6C30 3.2 66 2.8 97 4.8" />
          </svg>
          <div className="home-doors" role="group" aria-label={t('entry.choose')}>
            {/* Personal on the left and Business on the right, in every language. */}
            <Door href={paths.personal} product="Personal" label={t('entry.openPersonal')} />
            <Door href={paths.business} product="Business" label={t('entry.openBusiness')} />
          </div>
          <svg
            className="home-hero__waves"
            viewBox="0 0 1440 120"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              className="home-hero__wave home-hero__wave--start"
              d="M0 120V64C110 30 230 26 330 72c30 14 52 32 64 48Z"
            />
            <path
              className="home-hero__wave home-hero__wave--end"
              d="M1440 120V46c-120-20-250-6-360 40-30 12-50 22-64 34Z"
            />
          </svg>
        </section>
      </main>
      <footer className="home-legal" lang="en" dir="ltr">
        <p>©1to1OS.com — A Product by Cosmic Advertising Solutions Cairo, Egypt.</p>
        <p>Tax Registration No.: 337-690-510</p>
      </footer>
    </div>
  );
}
