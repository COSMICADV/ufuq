import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { AdminPayslip } from '../../../../../../components/payroll/payroll-payslip';
import { PayrollShell } from '../../../../../../components/payroll/payroll-shared';
import { LoadingFallback } from '../../../../../../components/settings/loading-fallback';
import { payrollPath } from '../../../../../../lib/payroll';

interface PageProps {
  readonly params: Promise<{
    readonly locale: string;
    readonly periodId: string;
    readonly employeeId: string;
  }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/payroll/:periodId/:employeeId` — DOCUMENT 04 "Payslip breakdown". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, periodId, employeeId } = await params;
  if (!isLocale(locale) || !UUID.test(periodId) || !UUID.test(employeeId)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <PayrollShell
      locale={locale}
      surface="admin"
      back={{ href: payrollPath(locale, periodId), label: t('payroll.back_to_run') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <AdminPayslip locale={locale} periodId={periodId} employeeId={employeeId} />
      </Suspense>
    </PayrollShell>
  );
}
