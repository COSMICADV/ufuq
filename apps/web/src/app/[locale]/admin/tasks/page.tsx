import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../components/settings/loading-fallback';
import { TasksAdmin } from '../../../../components/tasks/tasks-admin';
import { TasksShell } from '../../../../components/tasks/tasks-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/tasks` — DOCUMENT 04 B8, table and board views.
 *
 * The screen is a client component because its state lives in the URL
 * (`useSearchParams`), which is why it sits inside a `Suspense` boundary whose
 * fallback is its own skeleton.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <TasksShell locale={locale} surface="admin">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <TasksAdmin locale={locale} />
      </Suspense>
    </TasksShell>
  );
}
