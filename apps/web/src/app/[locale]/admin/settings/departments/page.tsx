import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { SettingsShell } from '../../../../../components/settings/settings-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { DepartmentsSettings } from '../../../../../components/settings/departments-settings';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/settings/departments` — DOCUMENT 03 §3.
 *
 * A server component that does one thing: validate the locale from the path
 * and hand it to the screen. The screen itself is a client component because
 * it reads and writes live data; the frame around it is not, so the page's
 * navigation and breadcrumb cost the browser no JavaScript.
 *
 * The `Suspense` boundary is required by Next for a client component that
 * reads `useSearchParams` (the page number lives in the URL — DOCUMENT 11 §6),
 * and its fallback is the same skeleton the screen shows while loading rather
 * than a blank frame.
 */
export default async function DepartmentsSettingsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <SettingsShell locale={locale} section="departments">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <DepartmentsSettings locale={locale} />
      </Suspense>
    </SettingsShell>
  );
}
