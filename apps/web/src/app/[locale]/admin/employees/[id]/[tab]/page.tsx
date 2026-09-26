import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { EmployeeProfile } from '../../../../../../components/employees/employee-profile';
import { EmployeesShell } from '../../../../../../components/employees/employees-shell';
import { LoadingFallback } from '../../../../../../components/settings/loading-fallback';
import { EMPLOYEE_TABS } from '../../../../../../lib/employees';
import type { EmployeeTab } from '../../../../../../lib/employees';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string; readonly tab: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/employees/:id/{attendance,tasks,goals,salary,requests,reports}` —
 * DOCUMENT 03 §3's profile sub-routes. `edit` is its own static route and
 * takes precedence; `overview` has the profile's own address, so it is not a
 * valid segment here. Anything else is a 404.
 */
export default async function EmployeeTabPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id, tab } = await params;
  if (
    !isLocale(locale) ||
    !UUID.test(id) ||
    tab === 'overview' ||
    !(EMPLOYEE_TABS as readonly string[]).includes(tab)
  ) {
    notFound();
  }

  return (
    <EmployeesShell>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <EmployeeProfile locale={locale} employeeId={id} tab={tab as EmployeeTab} />
      </Suspense>
    </EmployeesShell>
  );
}
