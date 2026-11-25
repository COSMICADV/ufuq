import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { RestaurantPos } from '../../../../components/restaurant/pos';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/pos` — the visual point of sale. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RestaurantPos locale={locale} surface="app" />;
}
