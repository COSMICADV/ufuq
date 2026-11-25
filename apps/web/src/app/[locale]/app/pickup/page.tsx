import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { PickupBoard } from '../../../../components/restaurant/handover';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/pickup` — take-away and delivery orders ready to hand over. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PickupBoard locale={locale} surface="app" />;
}
