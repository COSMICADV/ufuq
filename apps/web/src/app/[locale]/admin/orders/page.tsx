import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { RestaurantOrders } from '../../../../components/restaurant/orders';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/orders` — open and today's orders. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RestaurantOrders locale={locale} surface="admin" />;
}
