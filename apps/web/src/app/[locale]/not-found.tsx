'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createTranslator } from '@ufuq/i18n';

import { BrandMark } from '../../components/brand-mark';
import { publicPath } from '../../lib/public-content';

/** A localized, navigable unavailable state in the same public brand system. */
export default function NotFound(): React.JSX.Element {
  const pathname = usePathname();
  const locale = pathname === '/en' || pathname?.startsWith('/en/') ? 'en' : 'ar';
  const t = createTranslator(locale);
  return (
    <main className="not-found-page">
      <section className="card not-found-card">
        <BrandMark />
        <p className="not-found-code" aria-hidden="true">
          404
        </p>
        <h1>{t('error.not_found')}</h1>
        <p>
          {locale === 'ar'
            ? 'يمكنك العودة إلى الرئيسية أو تسجيل الدخول لمتابعة عملك.'
            : 'Return home or sign in to continue your work.'}
        </p>
        <div className="button-row">
          <Link className="button button--primary" href={publicPath(locale, 'home')}>
            {locale === 'ar' ? 'الرئيسية' : 'Home'}
          </Link>
          <Link className="button button--secondary" href={publicPath(locale, 'login')}>
            {locale === 'ar' ? 'تسجيل الدخول' : 'Sign in'}
          </Link>
        </div>
      </section>
    </main>
  );
}
