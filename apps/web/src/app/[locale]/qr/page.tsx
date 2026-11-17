import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { isLocale } from '@ufuq/i18n';

import { QrShell } from '../../../components/qr/qr-shell';
import { QrStudio } from '../../../components/qr/qr-studio';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: locale === 'ar' ? 'استوديو QR — 1to1OS' : 'QR Studio — 1to1OS',
    robots: { index: false },
  };
}

/**
 * `/qr` — QR Studio: dynamic, branded QR codes. One of 1to1OS's products, on a page of
 * its own rather than inside the business workspace.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return (
    <QrShell locale={locale}>
      <QrStudio locale={locale} />
    </QrShell>
  );
}
