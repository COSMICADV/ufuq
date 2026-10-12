import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { MyPayslips } from '../../../../../components/payroll/my-salary';
import { PayrollShell } from '../../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { salaryPath } from '../../../../../lib/payroll';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/salary/history` — the employee's own finalized payslips. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <PayrollShell
      locale={locale}
      surface="app"
      back={{ href: salaryPath(locale), label: t('salary.back') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MyPayslips locale={locale} />
      </Suspense>
    </PayrollShell>
  );
}
