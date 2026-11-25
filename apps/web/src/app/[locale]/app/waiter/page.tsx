import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { WaiterBoard } from '../../../../components/restaurant/handover';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/waiter` — dine-in orders ready to serve. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <WaiterBoard locale={locale} surface="app" />;
}
