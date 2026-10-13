import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { WarehouseShell } from '../../../../../components/warehouse/warehouse-shared';
import { WarehouseTransfers } from '../../../../../components/warehouse/warehouse-transfers';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/warehouse/transfers` — DOCUMENT 04 B21, DOCUMENT 05 FLOW 18. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <WarehouseShell locale={locale} current="transfers">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <WarehouseTransfers locale={locale} />
      </Suspense>
    </WarehouseShell>
  );
}
