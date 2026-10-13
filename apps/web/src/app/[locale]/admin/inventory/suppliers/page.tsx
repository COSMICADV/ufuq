import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../../components/inventory/inventory-shared';
import { Suppliers } from '../../../../../components/inventory/suppliers';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/inventory/suppliers` — DOCUMENT 17 "Screens". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <InventoryShell locale={locale} current="suppliers">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <Suppliers locale={locale} />
      </Suspense>
    </InventoryShell>
  );
}
