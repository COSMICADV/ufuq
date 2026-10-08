import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { PerformanceSettings } from '../../../../../components/settings/performance-settings';
import { SettingsShell } from '../../../../../components/settings/settings-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/settings/performance` — DOCUMENT 04 B25 "Performance", DOCUMENT 14. */
export default async function PerformanceSettingsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <SettingsShell locale={locale} section="performance">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <PerformanceSettings locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
