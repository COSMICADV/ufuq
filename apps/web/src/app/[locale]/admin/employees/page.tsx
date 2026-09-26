import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { EmployeesList } from '../../../../components/employees/employees-list';
import { EmployeesShell } from '../../../../components/employees/employees-shell';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/employees` — DOCUMENT 03 §3, DOCUMENT 04 B2. The screen is a client
 * component because its filters live in the URL (`useSearchParams`), which is
 * why it sits inside a `Suspense` boundary whose fallback is its own skeleton.
 */
export default async function EmployeesPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <EmployeesShell>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <EmployeesList locale={locale} />
      </Suspense>
    </EmployeesShell>
  );
}
