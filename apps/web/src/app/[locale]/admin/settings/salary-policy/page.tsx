import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { SalaryPolicySettings } from '../../../../../components/payroll/salary-policy-settings';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { SettingsShell } from '../../../../../components/settings/settings-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/settings/salary-policy` — DOCUMENT 04 "Salary policy", DOCUMENT 15. */
export default async function SalaryPolicyPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <SettingsShell locale={locale} section="salary-policy">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <SalaryPolicySettings locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
