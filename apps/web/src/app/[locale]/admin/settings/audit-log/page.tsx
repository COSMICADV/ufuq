import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { AuditLog } from '../../../../../components/settings/audit-log';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { SettingsShell } from '../../../../../components/settings/settings-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/settings/audit-log` — DOCUMENT 03 §3, DOCUMENT 21 "UI".
 *
 * Same frame as every settings screen: the server component validates the
 * locale and hands it to the client screen, and the `Suspense` boundary is
 * what Next requires around a component that reads `useSearchParams` (the
 * filters and page live in the URL — DOCUMENT 11 §6).
 */
export default async function AuditLogSettingsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <SettingsShell locale={locale} section="audit-log">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <AuditLog locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
