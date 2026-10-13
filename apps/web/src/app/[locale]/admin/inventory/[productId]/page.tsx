import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../../components/inventory/inventory-shared';
import { ProductDetailScreen } from '../../../../../components/inventory/product-detail';
import { LoadingFallback } from '../../../../../components/settings/loading-fallback';
import { inventoryPath } from '../../../../../lib/inventory';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly productId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/inventory/:id` — DOCUMENT 04 B23 "Product detail". */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, productId } = await params;
  if (!isLocale(locale) || !UUID.test(productId)) {
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
        <ProductDetailScreen locale={locale} productId={productId} />
      </Suspense>
    </InventoryShell>
  );
}
