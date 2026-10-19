import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { ReportViewer } from '../../../../../components/reports/report-viewer';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { isReportKey } from '../../../../../lib/reports';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly reportKey: string }>;
}

/** `/admin/reports/:reportKey` — DOCUMENT 04 B18. An unknown report is a 404. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, reportKey } = await params;
  if (!isLocale(locale) || !isReportKey(reportKey)) {
    notFound();
  }
  return (
    <Suspense fallback={<LoadingFallback locale={locale} />}>
      <ReportViewer locale={locale} reportKey={reportKey} />
    </Suspense>
  );
}
