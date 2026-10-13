import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../components/inventory/inventory-shared';
import { ProductsList } from '../../../../components/inventory/products-list';
import { LoadingFallback } from '../../../../components/settings/loading-fallback';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/inventory` — DOCUMENT 04 B22 "Products". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <InventoryShell locale={locale} current="products">
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <ProductsList locale={locale} />
      </Suspense>
    </InventoryShell>
  );
}
