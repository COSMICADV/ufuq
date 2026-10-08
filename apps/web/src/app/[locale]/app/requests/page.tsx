import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { MyRequests } from '../../../../components/requests/my-requests';
import { RequestsShell } from '../../../../components/requests/requests-shell';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/requests` — DOCUMENT 04 C8, "My requests". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <RequestsShell locale={locale} surface="app">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MyRequests locale={locale} />
      </Suspense>
    </RequestsShell>
  );
}
