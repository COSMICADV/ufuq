import { createTranslator, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { LanguageSwitch } from '../language-switch';
import { ThemePicker } from '../theme-picker';
import { publicPath } from '../../lib/public-content';

import { SectionArt } from './business-art';
import type { SectionKey } from './business-art';

/**
 * 1to1OS Business — the page a visitor reaches after choosing Business on the
 * home page, before subscribing. One subscription holds five sections: the page
 * shows them so the plan is understood, and one button starts the subscription.
 *
 * The sections are shown, not linked: choosing a plan happens from "Start
 * subscription". It shares the home page's frame (`home.css`) and adds its own
 * parts in `business.css`. Words come from the i18n catalogue (`business.*`).
 */

/** The five sections, in reading order: the first sits at the start of the line (the right in Arabic). */
const SECTIONS: readonly SectionKey[] = ['team', 'tasks', 'inventory', 'reports', 'pos'];

export function businessPaths(locale: Locale): {
  readonly home: string;
  readonly login: string;
  readonly subscribe: string;
} {
  return {
    home: publicPath(locale, 'home'),
    login: publicPath(locale, 'login'),
    // The project's existing sign-up: a company's request for its workspace.
    subscribe: publicPath(locale, 'register'),
  };
}

export function BusinessPage({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const b = (key: string): string => t(`business.${key}`);
  const paths = businessPaths(locale);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="home biz">
      <a className="public-skip" href="#content">
        {publicCopy[locale].skip}
      </a>

      <header className="home-header">
        <div className="home-header__inner">
          <a className="home-logo biz-logo" href={paths.home} aria-label={`1to1OS — ${b('home')}`}>
            <ProductLogo product="Business" />
          </a>
          <nav className="home-nav biz-nav" aria-label={b('nav.label')} dir={dir}>
            <a href="#sections">{b('nav.features')}</a>
            <span className="biz-nav__sep" aria-hidden="true" />
            <a href={paths.login}>{b('nav.login')}</a>
          </nav>
        </div>
      </header>

      <main id="content">
        <section className="biz-hero" aria-labelledby="biz-title">
          <div className="biz-hero__text">
            <h1 id="biz-title" className="biz-title">
              <span className="biz-title__line">{b('headlineLine1')}</span> {b('headlineStart')}
              <span className="biz-title__mark">
                {b('headlineMark')}
                <svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M3 7C30 3.4 66 2.8 97 4.6" />
                </svg>
              </span>
              {b('headlineEnd')}
            </h1>
            <p className="biz-lead">{b('lead')}</p>
            <a className="biz-cta" href={paths.subscribe}>
              {b('cta')}
            </a>
          </div>
          <div className="biz-hero__art">
            {/* The approved illustration: an open work case with badges, a task list and boxes. */}
            <img
              className="business-art"
              src="/brand/business-open-case.webp"
              alt=""
              width={1412}
              height={971}
              decoding="async"
              fetchPriority="high"
            />
          </div>
        </section>

        <section id="sections" className="biz-sections" aria-labelledby="biz-sections-title">
          <h2 id="biz-sections-title">{b('sectionsTitle')}</h2>
          <ul className="biz-strip">
            {SECTIONS.map((key) => (
              <li key={key}>
                <SectionArt section={key} />
                <span>{b(key)}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="home-footer biz-footer">
        <div className="home-footer__inner">
          <a className="home-logo home-logo--small" href={paths.home} aria-label="1to1OS">
            <ProductLogo />
          </a>
          <nav className="home-footer__links" aria-label={t('home.footer.label')}>
            <a href={paths.home}>{b('home')}</a>
            <a href="#sections">{b('nav.features')}</a>
            <a href={paths.login}>{b('nav.login')}</a>
            <a href={paths.subscribe}>{b('cta')}</a>
          </nav>
          <div className="home-footer__prefs" role="group" aria-label={t('home.footer.prefs')}>
            <LanguageSwitch
              locale={locale}
              label={t('language.switch')}
              names={{ ar: t('language.ar'), en: t('language.en') }}
            />
            <ThemePicker locale={locale} />
          </div>
          <p className="home-footer__rights">
            {t('home.footer.rights', { year: String(new Date().getFullYear()) })}
          </p>
        </div>
      </footer>
    </div>
  );
}
