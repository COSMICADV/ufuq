import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { MySalary } from '../../../../components/payroll/my-salary';
import { PayrollShell } from '../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/salary` — DOCUMENT 15 "EMPLOYEE SALARY VIEW": the provisional current month. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <PayrollShell locale={locale} surface="app">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MySalary locale={locale} />
      </Suspense>
    </PayrollShell>
  );
}
