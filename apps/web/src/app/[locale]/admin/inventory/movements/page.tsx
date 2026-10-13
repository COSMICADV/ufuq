import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../../components/inventory/inventory-shared';
import { MovementsLedger } from '../../../../../components/inventory/movements-ledger';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/inventory/movements` — DOCUMENT 04 B24 "Stock movements". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <InventoryShell locale={locale} current="movements">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MovementsLedger locale={locale} />
      </Suspense>
    </InventoryShell>
  );
}
