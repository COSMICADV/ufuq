import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { TaskDetailScreen } from '../../../../../components/tasks/task-detail';
import { TasksShell } from '../../../../../components/tasks/tasks-shell';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/tasks/:id` — DOCUMENT 04 B9. A path id that is
 * not a UUID can name no task, so it is a 404 before any request is made.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) {
    notFound();
  }

  return (
    <TasksShell locale={locale} surface="admin" back>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <TaskDetailScreen locale={locale} taskId={id} surface="admin" />
      </Suspense>
    </TasksShell>
  );
}
