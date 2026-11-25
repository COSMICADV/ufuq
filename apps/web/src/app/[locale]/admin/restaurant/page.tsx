import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { RestaurantHome } from '../../../../components/restaurant/setup';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/restaurant` — restaurant home — setup and live counts. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RestaurantHome locale={locale} surface="admin" />;
}
