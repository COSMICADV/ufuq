import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { PayrollRun } from '../../../../../components/payroll/payroll-run';
import { PayrollShell } from '../../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { payrollPath } from '../../../../../lib/payroll';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly periodId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/payroll/:periodId` — DOCUMENT 04 "Payroll run", DOCUMENT 05 FLOW 16. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, periodId } = await params;
  if (!isLocale(locale) || !UUID.test(periodId)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <PayrollShell
      locale={locale}
      surface="admin"
      back={{ href: payrollPath(locale), label: t('payroll.back_to_periods') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <PayrollRun locale={locale} periodId={periodId} />
      </Suspense>
    </PayrollShell>
  );
}
