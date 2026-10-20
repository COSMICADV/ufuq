import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { Locale } from '@ufuq/i18n';
import { PUBLIC_PAGES, features, publicCopy, publicPath } from '../../lib/public-content';
import type { PublicPage } from '../../lib/public-content';
import { BrandMark } from '../brand-mark';
import { PublicForm } from './public-form';

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
        ar: publicPath('ar', page),
        en: publicPath('en', page),
        'x-default': publicPath('ar', page),
      },
    },
    openGraph: {
      type: 'website',
      title: c.titles[i],
      description: c.descriptions[i],
      url,
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? 'en_US' : 'ar_EG',
      siteName: c.brand,
    },
    ...(page === 'login' || page === 'register' ? { robots: { index: false, follow: true } } : {}),
  };
}
export function PublicSite({
  locale,
  page,
  reset = false,
}: {
  readonly locale: Locale;
  readonly page: PublicPage;
  readonly reset?: boolean;
}): React.JSX.Element {
  const c = publicCopy[locale];
  const index = PUBLIC_PAGES.indexOf(page);
  const link = (p: PublicPage, primary = false): React.JSX.Element => (
    <Link
      className={`button button--${primary ? 'primary' : 'secondary'} button--lg`}
      href={publicPath(locale, p)}
    >
      {p === 'register' ? c.start : p === 'features' ? c.explore : c.contact}
    </Link>
  );
  const nav = (pages: readonly PublicPage[]): React.JSX.Element[] =>
    pages.map((p) => (
      <Link key={p} href={publicPath(locale, p)} aria-current={p === page ? 'page' : undefined}>
        {c.nav[PUBLIC_PAGES.indexOf(p)]}
      </Link>
    ));
  const websiteData = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: c.brand,
    url: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    inLanguage: ['ar', 'en'],
  }).replace(/</g, '\\u003c');
  const language = (
    <a
      href={publicPath(locale === 'ar' ? 'en' : 'ar', page)}
      lang={locale === 'ar' ? 'en' : 'ar'}
      hrefLang={locale === 'ar' ? 'en' : 'ar'}
    >
      {c.language}
    </a>
  );
  return (
    <div className={`public-site public-site--${page}`}>
      <a className="public-skip" href="#content">
        {c.skip}
      </a>
      <header className="public-header">
        <Link className="public-brand" href={publicPath(locale, 'home')}>
          <BrandMark />
          {c.brand}
        </Link>
        <nav aria-label={c.menu} className="public-desktop-nav">
          {nav(['home', 'features', 'for-companies', 'pricing', 'contact'])}
        </nav>
        <div className="public-account">
          {language}
          {nav(['login'])}
          {link('register', true)}
        </div>
        <details className="public-mobile-nav">
          <summary>{c.menu}</summary>
          <nav aria-label={c.menu}>
            {nav(['home', 'features', 'for-companies', 'pricing', 'contact'])}
          </nav>
        </details>
      </header>
      <main id="content">
        {page === 'home' ? (
          <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: websiteData }} />
        ) : null}
        <section className={`public-intro ${page === 'home' ? 'public-hero' : ''}`}>
          <div className="public-wrap">
            <p className="public-eyebrow">{page === 'for-individuals' ? c.coming : c.brand}</p>
            <h1>{reset ? c.forgot : c.titles[index]}</h1>
            <p>{reset ? c.resetInfo : c.descriptions[index]}</p>
            {page === 'home' ? (
              <div className="public-actions">
                {link('register', true)}
                {link('features')}
              </div>
            ) : null}
          </div>
          {page === 'home' ? (
            <figure className="public-hero-product public-wrap">
              <Image
                src={`/product/tasks-v2-${locale}.png`}
                alt={features[locale][2][0]}
                width={1280}
                height={800}
                sizes="(max-width: 800px) 100vw, 1120px"
                priority
              />
              <figcaption>{c.productCaption}</figcaption>
            </figure>
          ) : null}
        </section>
        <div className="public-wrap public-sections">
          {page === 'home' ? (
            <>
              <section>
                <h2>{c.problem}</h2>
                <p>{c.problemBody}</p>
              </section>
              <section>
                <h2>{c.solution}</h2>
                <ul className="public-chains">
                  {c.chains.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h2>{c.highlights}</h2>
                <div className="public-grid">
                  {[0, 1, 2, 6, 8, 9].map((i) => (
                    <article key={i}>
                      <h3>
                        <Link href={publicPath(locale, 'features')}>
                          {features[locale][i]?.[0]}
                        </Link>
                      </h3>
                      <p>{features[locale][i]?.[1]}</p>
                    </article>
                  ))}
                </div>
              </section>
              <section>
                <h2>{c.audience}</h2>
                <div className="public-grid">
                  <article>
                    <h3>{c.companies}</h3>
                    <p>{c.descriptions[3]}</p>
                    {nav(['for-companies'])}
                  </article>
                  <article>
                    <h3>
                      {c.nav[4]} · {c.coming}
                    </h3>
                    <p>{c.descriptions[4]}</p>
                    {nav(['for-individuals'])}
                  </article>
                </div>
              </section>
              <section>
                <h2>{c.trust}</h2>
                <ul>
                  {c.trustItems.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </section>
            </>
          ) : null}
          {page === 'features' ? (
            <section>
              <h2>{c.product}</h2>
              <figure>
                <Image
                  src={`/product/tasks-v2-${locale}.png`}
                  alt={features[locale][2][0]}
                  width={1280}
                  height={800}
                  sizes="(max-width: 800px) 100vw, 1120px"
                />
                <figcaption>{c.productCaption}</figcaption>
              </figure>
            </section>
          ) : null}
          {page === 'about' ? (
            <section>
              {c.about.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </section>
          ) : null}
          {page === 'features' ? (
            <section className="public-grid">
              {features[locale].map(([title, body], i) => (
                <article key={title}>
                  <span className="public-feature-number" aria-hidden="true">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h2>{title}</h2>
                  <p>{body}</p>
                </article>
              ))}
            </section>
          ) : null}
          {page === 'for-companies' ? (
            <>
              <section>
                <ul>
                  {c.useCases.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h2>{c.onboarding}</h2>
                <ol className="public-steps">
                  {c.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </section>
            </>
          ) : null}
          {page === 'for-individuals' ? (
            <section>
              <h2>{c.companies}</h2>
              <p>{c.descriptions[3]}</p>
              {nav(['for-companies'])}
            </section>
          ) : null}
          {page === 'pricing' ? (
            <section>
              <p>{c.pricingNote}</p>
              <h2>{c.faq}</h2>
              <p>{c.pricingFaq}</p>
              {link('contact', true)}
            </section>
          ) : null}
          {page === 'contact' || page === 'register' || page === 'login' ? (
            <section className="public-form-panel">
              <PublicForm
                key={`${locale}-${page}-${String(reset)}`}
                locale={locale}
                kind={page === 'login' && reset ? 'forgot' : page}
              />
            </section>
          ) : null}
          {page !== 'login' && page !== 'register' ? (
            <section className="public-final">
              <h2>{c.final}</h2>
              {link('register', true)}
            </section>
          ) : null}
        </div>
      </main>
      <footer className="public-footer">
        <div className="public-wrap">
          <strong className="public-brand">{c.brand}</strong>
          <p>{c.footer}</p>
          <nav aria-label={c.footer}>
            {nav(PUBLIC_PAGES)}
            {language}
          </nav>
        </div>
      </footer>
    </div>
  );
}
