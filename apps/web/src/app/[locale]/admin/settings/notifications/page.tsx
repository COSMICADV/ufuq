import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { NotificationSettings } from '../../../../../components/settings/notification-settings';
import { SettingsShell } from '../../../../../components/settings/settings-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/settings/notifications` — DOCUMENT 04 B25 "Notifications", DOCUMENT 19 rule 10. */
export default async function NotificationSettingsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <SettingsShell locale={locale} section="notifications">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <NotificationSettings locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
