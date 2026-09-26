import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { EmployeeForm } from '../../../../../components/employees/employee-form';
import { EmployeesShell } from '../../../../../components/employees/employees-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/employees/new` — DOCUMENT 03 §3, DOCUMENT 04 B3. */
export default async function NewEmployeePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <EmployeesShell>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <EmployeeForm locale={locale} employeeId={null} />
      </Suspense>
    </EmployeesShell>
  );
}
