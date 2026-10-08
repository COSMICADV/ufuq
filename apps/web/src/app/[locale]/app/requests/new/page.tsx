import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { RequestFormScreen } from '../../../../../components/requests/request-form';
import { RequestsShell } from '../../../../../components/requests/requests-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/requests/new` — DOCUMENT 04 C9, a new request. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <RequestsShell locale={locale} surface="app" back heading="new">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <RequestFormScreen locale={locale} />
      </Suspense>
    </RequestsShell>
  );
}
