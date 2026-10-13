import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { WarehouseLocations } from '../../../../../components/warehouse/warehouse-locations';
import { WarehouseShell } from '../../../../../components/warehouse/warehouse-shared';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/warehouse/locations` — DOCUMENT 04 B20 "Warehouse locations". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <WarehouseShell locale={locale} current="locations">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <WarehouseLocations locale={locale} />
      </Suspense>
    </WarehouseShell>
  );
}
