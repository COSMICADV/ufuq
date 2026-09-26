import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { CorrectionsList } from '../../../../../components/attendance/corrections-list';
import { AttendanceShell } from '../../../../../components/attendance/attendance-shell';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/attendance/corrections` — DOCUMENT 04 B7.
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
    <AttendanceShell locale={locale} active="corrections">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <CorrectionsList locale={locale} />
      </Suspense>
    </AttendanceShell>
  );
}
