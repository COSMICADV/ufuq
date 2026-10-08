import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { GoalsShell } from '../../../../components/goals/goals-shell';
import { MyGoals } from '../../../../components/goals/my-goals';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/goals` — DOCUMENT 03 §4 "My goals": the employee's goal cards. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <GoalsShell locale={locale} surface="app">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MyGoals locale={locale} />
      </Suspense>
    </GoalsShell>
  );
}
