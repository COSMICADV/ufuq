import { createTranslator, getDirection, LOCALES } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { FreehandIcon } from '../freehand-icon';

/**
 * The first screen of 1to1OS: the five languages. Each card is written in its
 * own language and opens the product choice in that language (`/{locale}`).
 * The page itself has no language of its own, so every card and the line under
 * the title carry their own `lang` and `dir`.
 */
export function LanguagePage(): React.JSX.Element {
  const en = createTranslator('en');
  const others = LOCALES.filter((locale) => locale !== 'en');

  return (
    <div className="home lang-page" dir="ltr">
      <header className="home-header">
        <div className="home-header__inner">
          <a className="home-logo" href="/" aria-label="1to1OS">
            <ProductLogo domain />
          </a>
        </div>
      </header>

      <main id="content">
        <section className="home-hero home-hero--only" aria-labelledby="lang-title">
          <div className="lang-page__head">
            <h1 id="lang-title" className="home-title" lang="en">
              {en('entry.chooseLanguage')}
            </h1>
            <p className="lang-page__also">
              {others.map((locale, index) => (
                <span key={locale}>
                  {index > 0 ? (
                    <span className="lang-page__dot" aria-hidden="true">
                      ·
                    </span>
                  ) : null}
                  <span lang={locale} dir={getDirection(locale)}>
                    {createTranslator(locale)('entry.chooseLanguage')}
                  </span>
                </span>
              ))}
            </p>
          </div>

          <ul className="lang-cards">
            {LOCALES.map((locale) => {
              const t = createTranslator(locale);
              return (
                <li key={locale}>
                  <a
                    className="lang-card"
                    href={`/${locale}`}
                    lang={locale}
                    hrefLang={locale}
                    dir={getDirection(locale)}
                  >
                    <span className="lang-card__code" aria-hidden="true">
                      {locale.toUpperCase()}
                    </span>
                    <span className="lang-card__name">
                      {t(`language.${locale}`)}
                      <svg
                        className="home-door__brush"
                        viewBox="0 0 100 10"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <path d="M3 6.6C30 3.2 66 2.8 97 4.8" />
                      </svg>
                    </span>
                    <span className="lang-card__go">
                      {t('entry.continue')}
                      <FreehandIcon name="chevron" size={18} />
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>

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
    </div>
  );
}
