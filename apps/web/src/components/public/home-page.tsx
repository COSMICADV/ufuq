import { createTranslator, publicCopy } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from '../brand-mark';
import { FreehandIcon } from '../freehand-icon';
import { NavGlyph } from '../nav-glyph';
import type { NavGlyphName } from '../nav-glyph';
import { LanguageSwitch } from '../language-switch';
import { ThemePicker } from '../theme-picker';
import { publicPath } from '../../lib/public-content';

/**
 * The public home page of 1to1OS.
 *
 * First screen: one headline and two doors, Business and Personal, each opening
 * its product. Below: the tools of the product as a plain grid, the current
 * prices, and a small footer with the language and theme. Every word comes from the i18n catalogue (`home.*`, `entry.*`), so
 * Arabic (right to left) and English share this one component.
 */

/** Where each link on the page leads — the product's existing routes. */
export function homePaths(locale: Locale): {
  readonly home: string;
  readonly business: string;
  readonly personal: string;
  readonly login: string;
  readonly employeeLogin: string;
  readonly register: string;
  readonly about: string;
  readonly contact: string;
} {
  const login = publicPath(locale, 'login');
  return {
    home: publicPath(locale, 'home'),
    // The Business page: what the subscription holds, and where it starts.
    business: `${locale === 'ar' ? '' : '/en'}/business`,
    personal: publicPath(locale, 'for-individuals'),
    login,
    employeeLogin: `${login}?as=employee`,
    register: publicPath(locale, 'register'),
    about: publicPath(locale, 'about'),
    contact: publicPath(locale, 'contact'),
  };
}

/** The tools of the product, in the order of its own menu. */
const TOOLS: readonly (readonly [string, NavGlyphName])[] = [
  ['employees', 'employees'],
  ['attendance', 'attendance'],
  ['tasks', 'tasks'],
  ['goals', 'goals'],
  ['requests', 'requests'],
  ['leave', 'leave'],
  ['payroll', 'payroll'],
  ['reports', 'reports'],
  ['warehouses', 'warehouse'],
  ['inventory', 'inventory'],
  ['notifications', 'notifications'],
];

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

interface Plan {
  readonly key: 'starter' | 'pro' | 'ent';
  readonly monthly: string;
  readonly annual: string;
  readonly points: number;
  readonly href: string;
  readonly featured?: boolean;
}

export function HomePage({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const h = (key: string, values?: Record<string, string>): string => t(`home.${key}`, values);
  const paths = homePaths(locale);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  const plans: readonly Plan[] = [
    { key: 'starter', monthly: '$0', annual: '$0', points: 1, href: paths.register },
    { key: 'pro', monthly: '$36', annual: '$29', points: 1, href: paths.register, featured: true },
    { key: 'ent', monthly: '$109', annual: '$89', points: 2, href: paths.contact },
  ];

  return (
    <div className="home">
      <a className="public-skip" href="#content">
        {publicCopy[locale].skip}
      </a>

      <header className="home-header">
        <div className="home-header__inner">
          <a className="home-logo" href={paths.home} aria-label="1to1OS">
            <ProductLogo domain />
          </a>
          <nav className="home-nav" aria-label={h('nav.label')} dir={dir}>
            <a href={paths.home} aria-current="page">
              {h('nav.home')}
            </a>
            <a href="#features">{h('nav.features')}</a>
            <a href={paths.about}>{h('nav.about')}</a>
          </nav>
        </div>
      </header>

      <main id="content">
        <section className="home-hero" aria-labelledby="home-title">
          <h1 id="home-title" className="home-title">
            {t('entry.headlineStart')}
            <span className="home-title__keep">
              {t('entry.headlineMark')}
              {t('entry.headlineJoin')}
            </span>
            <span className="home-title__end">{t('entry.headlineEnd')}</span>
          </h1>
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

        <section
          id="features"
          className="home-section home-features"
          aria-labelledby="home-features-title"
        >
          <div className="home-section__head">
            <h2 id="home-features-title">{h('features.title')}</h2>
            <p>{h('features.lead')}</p>
          </div>
          <ul className="home-tools">
            {TOOLS.map(([key, icon]) => (
              <li key={key}>
                <span className="home-tools__icon">
                  <NavGlyph name={icon} size={38} />
                </span>
                <span className="home-tools__name">{h(`features.${key}`)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="pricing"
          className="home-section home-pricing"
          aria-labelledby="home-pricing-title"
        >
          <div className="home-section__head">
            <h2 id="home-pricing-title">{h('pricing.title')}</h2>
            <p>{h('pricing.lead')}</p>
          </div>
          <fieldset className="home-billing">
            <legend className="home-sr">{h('pricing.billing')}</legend>
            <input type="radio" name="home-billing" id="home-billing-monthly" defaultChecked />
            <label htmlFor="home-billing-monthly">{h('pricing.monthly')}</label>
            <input type="radio" name="home-billing" id="home-billing-annual" />
            <label htmlFor="home-billing-annual">
              {h('pricing.annual')}
              <span className="home-billing__save">{h('pricing.save')}</span>
            </label>
          </fieldset>
          <div className="home-plans">
            {plans.map((plan) => (
              <article
                key={plan.key}
                className={`home-plan${plan.featured ? ' home-plan--featured' : ''}`}
                aria-labelledby={`home-plan-${plan.key}`}
              >
                {plan.featured ? (
                  <span className="home-plan__ribbon">{h('pricing.proRibbon')}</span>
                ) : null}
                <div className="home-plan__head">
                  <h3 id={`home-plan-${plan.key}`}>{h(`pricing.${plan.key}Name`)}</h3>
                  <span className="home-plan__badge">{h(`pricing.${plan.key}Badge`)}</span>
                </div>
                <p className="home-plan__desc">{h(`pricing.${plan.key}Desc`)}</p>
                <p className="home-plan__price">
                  <span className="home-plan__amount home-plan__amount--monthly" dir="ltr">
                    {plan.monthly}
                  </span>
                  <span className="home-plan__amount home-plan__amount--annual" dir="ltr">
                    {plan.annual}
                  </span>
                  <small>{h('pricing.perMonth')}</small>
                </p>
                <ul className="home-plan__points">
                  {Array.from({ length: plan.points }, (_, i) => (
                    <li key={i}>
                      <FreehandIcon name="check" size={20} />
                      <span>{h(`pricing.${plan.key}P${i + 1}`)}</span>
                    </li>
                  ))}
                </ul>
                <a className="home-plan__cta" href={plan.href}>
                  {h(`pricing.${plan.key}Cta`)}
                </a>
              </article>
            ))}
          </div>
          <p className="home-pricing__note">{h('pricing.note')}</p>
        </section>
      </main>

      <footer className="home-footer">
        <div className="home-footer__inner">
          <a className="home-logo home-logo--small" href={paths.home} aria-label="1to1OS">
            <ProductLogo />
          </a>
          <nav className="home-footer__links" aria-label={h('footer.label')}>
            <a href="#features">{h('nav.features')}</a>
            <a href="#pricing">{h('pricing.title')}</a>
            <a href={paths.about}>{h('footer.about')}</a>
            <a href={paths.contact}>{h('footer.contact')}</a>
            <a href={paths.login}>{h('nav.login')}</a>
            <a href={paths.employeeLogin}>{h('nav.loginEmployee')}</a>
            <a href={paths.register}>{h('footer.register')}</a>
          </nav>
          <div className="home-footer__prefs" role="group" aria-label={h('footer.prefs')}>
            <LanguageSwitch
              locale={locale}
              label={t('language.switch')}
              names={{ ar: t('language.ar'), en: t('language.en') }}
            />
            <ThemePicker locale={locale} />
          </div>
          <p className="home-footer__rights">
            {h('footer.rights', { year: String(new Date().getFullYear()) })}
          </p>
        </div>
      </footer>
    </div>
  );
}
