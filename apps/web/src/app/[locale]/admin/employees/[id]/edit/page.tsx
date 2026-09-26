import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { EmployeeForm } from '../../../../../../components/employees/employee-form';
import { EmployeesShell } from '../../../../../../components/employees/employees-shell';
import { LoadingFallback } from '../../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/employees/:id/edit` — DOCUMENT 03 §3, DOCUMENT 04 B3. */
export default async function EditEmployeePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) {
    notFound();
  }

  return (
    <EmployeesShell>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <EmployeeForm locale={locale} employeeId={id} />
      </Suspense>
    </EmployeesShell>
  );
}
