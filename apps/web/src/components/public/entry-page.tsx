import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { LanguageSwitch } from '../language-switch';
import { publicPath } from '../../lib/public-content';

/**
 * The front door of 1to1OS: one headline and two doors, Personal and Business.
 *
 * It is deliberately quiet — no pricing, no forms — and always white, whatever
 * theme the visitor picked inside the product. The two illustrations are the
 * approved hand-drawn marks and are served as images, never redrawn.
 */

/** Where each door leads. Business opens the company site that used to be the home page. */
export function entryPaths(locale: Locale): { personal: string; business: string } {
  const prefix = locale === 'ar' ? '' : '/en';
  return {
    personal: publicPath(locale, 'for-individuals'),
    business: `${prefix}/business`,
  };
}

function Underline({ className }: { readonly className: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden="true">
      <path d="M4 9.5 C 50 4, 120 3.5, 196 6.5" />
    </svg>
  );
}

function Spark({ className }: { readonly className: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 4 L23 15" />
      <path d="M33 12 L26 19" />
      <path d="M37 27 L28 26" />
    </svg>
  );
}

function Chevron(): React.JSX.Element {
  return (
    <svg className="entry-card__chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 5 L16 12 L9 19" />
    </svg>
  );
}

interface DoorProps {
  readonly href: string;
  readonly kind: 'personal' | 'business';
  readonly name: string;
  readonly label: string;
}

function Door({ href, kind, name, label }: DoorProps): React.JSX.Element {
  return (
    <a className={`entry-card entry-card--${kind}`} href={href} aria-label={label}>
      <span className="entry-card__art">
        <img
          src={`/brand/${kind}-hand-drawn.png`}
          alt=""
          width={kind === 'personal' ? 266 : 277}
          height={kind === 'personal' ? 231 : 249}
          decoding="async"
        />
      </span>
      <span className="entry-card__rule" aria-hidden="true" />
      <span className="entry-card__name" dir="ltr" lang="en">
        <span className="entry-card__brand">1to1OS</span>{' '}
        <span className="entry-card__product">
          {name}
          <Underline className="entry-card__underline" />
        </span>
      </span>
      <Chevron />
    </a>
  );
}

export function EntryPage({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const paths = entryPaths(locale);

  return (
    <div className="entry">
      <header className="entry-header">
        <a className="entry-logo" href={publicPath(locale, 'home')} dir="ltr" lang="en">
          <span>1to1OS</span>
          <span className="entry-logo__tld">.com</span>
          <Underline className="entry-logo__underline" />
          <Spark className="entry-logo__spark" />
        </a>
        <div className="entry-header__end">
          <nav className="entry-nav" aria-label={t('entry.nav.label')}>
            <a href={publicPath(locale, 'home')} aria-current="page">
              {t('entry.nav.home')}
            </a>
            <a href={publicPath(locale, 'features')}>{t('entry.nav.features')}</a>
            <a href={publicPath(locale, 'about')}>{t('entry.nav.about')}</a>
          </nav>
          <LanguageSwitch
            locale={locale}
            label={t('language.switch')}
            names={{ ar: t('language.ar'), en: t('language.en') }}
          />
        </div>
      </header>

      <main className="entry-main">
        <h1 className="entry-title">
          {t('entry.headlineStart')}
          <span className="entry-title__keep">
            {t('entry.headlineMark')}
            {t('entry.headlineJoin')}
          </span>
          <span className="entry-title__end">{t('entry.headlineEnd')}</span>
        </h1>

        <section className="entry-doors" aria-label={t('entry.choose')}>
          <Door
            href={paths.personal}
            kind="personal"
            name="Personal"
            label={t('entry.openPersonal')}
          />
          <Door
            href={paths.business}
            kind="business"
            name="Business"
            label={t('entry.openBusiness')}
          />
        </section>
      </main>

      <svg className="entry-waves" viewBox="0 0 1440 160" preserveAspectRatio="none" aria-hidden="true">
        <path className="entry-waves__back" d="M0 110 C 240 40, 420 150, 720 105 S 1200 30, 1440 80 L1440 160 L0 160 Z" />
        <path className="entry-waves__front" d="M0 135 C 300 90, 520 165, 820 130 S 1260 95, 1440 120 L1440 160 L0 160 Z" />
      </svg>
    </div>
  );
}
