import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { EmployeeProfile } from '../../../../../components/employees/employee-profile';
import { EmployeesShell } from '../../../../../components/employees/employees-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/employees/:id` — the Overview tab, DOCUMENT 03 §3, DOCUMENT 04 B4.
 * A path id that is not a UUID can name no employee, so it is a 404 before any
 * request is made.
 */
export default async function EmployeePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) {
    notFound();
  }

  return (
    <EmployeesShell>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <EmployeeProfile locale={locale} employeeId={id} tab="overview" />
      </Suspense>
    </EmployeesShell>
  );
}
