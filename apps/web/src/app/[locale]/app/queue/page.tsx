import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { ReceptionQueue } from '../../../../components/medical/reception-queue';
import '../../../../styles/medical.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/queue` — reception and the day's queue. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <ReceptionQueue locale={locale} surface="app" />;
}
