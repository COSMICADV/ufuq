import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { MyMonthlyReport } from '../../../../../components/reports/my-monthly-report';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { isMonthKey } from '../../../../../lib/reports';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly month: string }>;
}

/** `/app/reports/:month` — DOCUMENT 04 C13, DOCUMENT 03 §4. `month` is `YYYY-MM`. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, month } = await params;
  if (!isLocale(locale) || !isMonthKey(month)) {
    notFound();
  }
  return (
    <Suspense fallback={<LoadingFallback locale={locale} />}>
      <MyMonthlyReport locale={locale} month={month} />
    </Suspense>
  );
}
