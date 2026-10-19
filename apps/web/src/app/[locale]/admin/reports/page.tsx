import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { ReportCatalogue } from '../../../../components/reports/report-catalogue';
import { ReportsShell } from '../../../../components/reports/report-shared';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/reports` — DOCUMENT 04 B17, DOCUMENT 03 §2 item 8. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <ReportsShell title={t('reports.title')} description={t('reports.description')}>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <ReportCatalogue locale={locale} />
      </Suspense>
    </ReportsShell>
  );
}
