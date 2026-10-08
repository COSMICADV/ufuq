import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { RequestsAdmin } from '../../../../components/requests/requests-admin';
import { RequestsShell } from '../../../../components/requests/requests-shell';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/requests` — DOCUMENT 04 B13, the unified inbox. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <RequestsShell locale={locale} surface="admin">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <RequestsAdmin locale={locale} />
      </Suspense>
    </RequestsShell>
  );
}
