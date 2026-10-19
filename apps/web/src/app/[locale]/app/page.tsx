import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { EmployeeDashboard } from '../../../components/dashboard/employee-dashboard';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/app` — DOCUMENT 04 C1, DOCUMENT 03 employee navigation item 1 ("الرئيسية / Home"). See
 * `employee-dashboard.tsx` for what it holds so far, and why only that.
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
          <h1>{t('dashboard.app_title')}</h1>
          <p>{t('dashboard.description')}</p>
        </div>
        {/* DOCUMENT 04 C13 — the employee's own monthly report. */}
        <Link className="button button--secondary button--md" href={`/${locale}/app/reports`}>
          <span>{t('reports.monthly.open_mine')}</span>
        </Link>
      </header>
      <main className="tasks-page__content">
        <EmployeeDashboard locale={locale} />
      </main>
    </div>
  );
}
