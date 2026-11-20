'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';

import { localeFromPath } from '../../lib/locale-route';

import { BrandMark, Wordmark } from '../../components/brand-mark';
import { publicPath } from '../../lib/public-content';

/** A localized, navigable unavailable state in the same public brand system. */
export default function NotFound(): React.JSX.Element {
  const pathname = usePathname();
  const locale = localeFromPath(pathname ?? '/') ?? 'ar';
  const t = createTranslator(locale);
  return (
    <main className="not-found-page">
      <section className="card not-found-card">
        <span className="public-brand">
          <BrandMark />
          <Wordmark />
        </span>
        <p className="not-found-code" aria-hidden="true">
          404
        </p>
        <h1>{t('error.not_found')}</h1>
        <p>{t('shell.not_found_body')}</p>
        <div className="button-row">
          <Link className="button button--primary" href={publicPath(locale, 'home')}>
            {t('shell.nav.home')}
          </Link>
          <Link className="button button--secondary" href={publicPath(locale, 'login')}>
            {t('home.nav.login')}
          </Link>
        </div>
      </section>
    </main>
  );
}
