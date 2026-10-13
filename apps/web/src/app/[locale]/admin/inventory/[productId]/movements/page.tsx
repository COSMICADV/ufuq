import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import { Suspense } from 'react';

import { InventoryShell } from '../../../../../../components/inventory/inventory-shared';
import { MovementsLedger } from '../../../../../../components/inventory/movements-ledger';
import { LoadingFallback } from '../../../../../../components/settings/loading-fallback';
import { productPath } from '../../../../../../lib/inventory';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly productId: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/inventory/:id/movements` — the product's movement history. */
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
      back={{ href: productPath(locale, productId), label: t('inventory.back_to_product') }}
    >
      <Suspense fallback={<LoadingFallback locale={locale} />}>
        <MovementsLedger locale={locale} productId={productId} />
      </Suspense>
    </InventoryShell>
  );
}
