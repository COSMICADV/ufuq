import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { MyPayslip } from '../../../../../components/payroll/payroll-payslip';
import { PayrollShell } from '../../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { salaryPath } from '../../../../../lib/payroll';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly periodId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/app/salary/:periodId` — the employee's own finalized payslip. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, periodId } = await params;
  if (!isLocale(locale) || !UUID.test(periodId)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <PayrollShell
      locale={locale}
      surface="app"
      back={{ href: salaryPath(locale, 'history'), label: t('salary.back_to_history') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MyPayslip locale={locale} periodId={periodId} />
      </Suspense>
    </PayrollShell>
  );
}
