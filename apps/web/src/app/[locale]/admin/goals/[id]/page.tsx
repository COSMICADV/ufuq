import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { GoalDetailScreen } from '../../../../../components/goals/goal-detail';
import { GoalsShell } from '../../../../../components/goals/goals-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/admin/goals/:id` — DOCUMENT 04 B12. A path id that is not a UUID can name
 * no goal, so it is a 404 before any request is made.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) {
    notFound();
  }
  return (
    <GoalsShell locale={locale} surface="admin" back>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <GoalDetailScreen locale={locale} goalId={id} surface="admin" />
      </Suspense>
    </GoalsShell>
  );
}
