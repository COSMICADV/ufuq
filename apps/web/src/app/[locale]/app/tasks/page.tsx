import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../components/settings/loading-fallback';
import { MyTasks } from '../../../../components/tasks/my-tasks';
import { TasksShell } from '../../../../components/tasks/tasks-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/tasks` — DOCUMENT 04 C5, the employee's grouped list. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <TasksShell locale={locale} surface="app">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MyTasks locale={locale} />
      </Suspense>
    </TasksShell>
  );
}
