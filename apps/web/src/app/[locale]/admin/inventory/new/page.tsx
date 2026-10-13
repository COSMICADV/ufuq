import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../../components/inventory/inventory-shared';
import { NewProduct } from '../../../../../components/inventory/product-form';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { inventoryPath } from '../../../../../lib/inventory';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/inventory/new` — DOCUMENT 05 FLOW 17. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  const t = createTranslator(locale);
  return (
    <InventoryShell
      locale={locale}
      current="products"
      back={{ href: inventoryPath(locale), label: t('inventory.back_to_products') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <NewProduct locale={locale} />
      </Suspense>
    </InventoryShell>
  );
}
