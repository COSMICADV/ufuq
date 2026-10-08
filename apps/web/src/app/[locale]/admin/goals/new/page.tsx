import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { GoalForm } from '../../../../../components/goals/goal-form';
import { GoalsShell } from '../../../../../components/goals/goals-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/goals/new` — DOCUMENT 04 B11 create form, DOCUMENT 05 FLOW 12. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <GoalsShell locale={locale} surface="admin" back>
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <GoalForm locale={locale} goal={null} />
      </Suspense>
    </GoalsShell>
  );
}
