import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { AdminDashboard } from '../../../components/dashboard/admin-dashboard';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin` — DOCUMENT 04 B1, DOCUMENT 03 §2 item 1 ("الرئيسية / Dashboard").
 * See `admin-dashboard.tsx` for what it holds so far, and why only that.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  const t = createTranslator(locale);

  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{t('dashboard.title')}</h1>
          <p>{t('dashboard.description')}</p>
        </div>
        {/* DOCUMENT 03 §2 item 8 — the report catalogue (B17). */}
        <Link className="button button--secondary button--md" href={`/${locale}/admin/reports`}>
          <span>{t('reports.open_catalogue')}</span>
        </Link>
      </header>
      <main className="tasks-page__content">
        <AdminDashboard locale={locale} />
      </main>
    </div>
  );
}
