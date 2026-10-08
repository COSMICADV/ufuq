import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { RequestDetailScreen } from '../../../../../components/requests/request-detail';
import { RequestsShell } from '../../../../../components/requests/requests-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/app/requests/:id` — DOCUMENT 04 C10. A path id that is not a UUID can name no request, so it is a 404
 * before any request is made.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) {
    notFound();
  }
  return (
    <RequestsShell locale={locale} surface="app" back>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <RequestDetailScreen locale={locale} requestId={id} surface="app" />
      </Suspense>
    </RequestsShell>
  );
}
