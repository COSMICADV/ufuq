import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { GoalsAdmin } from '../../../../components/goals/goals-admin';
import { GoalsShell } from '../../../../components/goals/goals-shell';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/goals` — DOCUMENT 04 B11. Filters live in the URL, hence the `Suspense`. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <GoalsShell locale={locale} surface="admin">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <GoalsAdmin locale={locale} />
      </Suspense>
    </GoalsShell>
  );
}
