import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { ReactNode } from 'react';

import { ProductShell } from '../../../components/product-shell';

interface LayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * Every `/app` screen sits under the shared header strip — the bell and
 * the language switch (DOCUMENT 03 §5, DOCUMENT 19 "Mobile behaviour").
 */
export default async function Layout({
  children,
  params,
}: LayoutProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <ProductShell locale={locale} surface="app">
      {children}
    </ProductShell>
  );
}
