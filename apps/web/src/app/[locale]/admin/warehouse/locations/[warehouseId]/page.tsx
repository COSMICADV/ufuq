import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../../components/settings/loading-fallback';
import { WarehouseLocation } from '../../../../../../components/warehouse/warehouse-location';
import { WarehouseShell } from '../../../../../../components/warehouse/warehouse-shared';
import { warehousePath } from '../../../../../../lib/warehouse';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly warehouseId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/warehouse/locations/:warehouseId` — one location's stock and movements. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, warehouseId } = await params;
  if (!isLocale(locale) || !UUID.test(warehouseId)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <WarehouseShell
      locale={locale}
      current="locations"
      back={{ href: warehousePath(locale, 'locations'), label: t('warehouse.back_to_locations') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <WarehouseLocation locale={locale} warehouseId={warehouseId} />
      </Suspense>
    </WarehouseShell>
  );
}
