import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { PayrollPeriods } from '../../../../components/payroll/payroll-periods';
import { PayrollShell } from '../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/payroll` — DOCUMENT 04 "Payroll", DOCUMENT 05 FLOW 14. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <PayrollShell locale={locale} surface="admin">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <PayrollPeriods locale={locale} />
      </Suspense>
    </PayrollShell>
  );
}
