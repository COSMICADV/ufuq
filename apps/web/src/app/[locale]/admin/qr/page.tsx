import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { QrStudio } from '../../../../components/qr/qr-studio';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/qr` — QR Studio: dynamic, branded QR codes, part of the business workspace. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return <QrStudio locale={locale} />;
}
