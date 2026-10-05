import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { TaskForm } from '../../../../../components/tasks/task-form';
import { TasksShell } from '../../../../../components/tasks/tasks-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/tasks/new` — DOCUMENT 04 B10, DOCUMENT 05 FLOW 09. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <TasksShell locale={locale} surface="admin" back>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <TaskForm locale={locale} task={null} />
      </Suspense>
    </TasksShell>
  );
}
