import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../components/settings/loading-fallback';
import { WarehouseDashboard } from '../../../../components/warehouse/warehouse-dashboard';
import { WarehouseShell } from '../../../../components/warehouse/warehouse-shared';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/warehouse` — DOCUMENT 04 B19 "Warehouse dashboard" (Phase 13 portions). */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <WarehouseShell locale={locale} current="dashboard">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <WarehouseDashboard locale={locale} />
      </Suspense>
    </WarehouseShell>
  );
}
