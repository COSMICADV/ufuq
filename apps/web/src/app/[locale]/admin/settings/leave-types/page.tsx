import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LeaveTypesSettings } from '../../../../../components/leave/leave-types-settings';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { SettingsShell } from '../../../../../components/settings/settings-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/settings/leave-types` — DOCUMENT 04 B25 "Leave types", DOCUMENT 16. */
export default async function LeaveTypesSettingsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <SettingsShell locale={locale} section="leave-types">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <LeaveTypesSettings locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
