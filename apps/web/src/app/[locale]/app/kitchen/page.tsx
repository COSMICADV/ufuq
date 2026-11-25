import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { KitchenDisplay } from '../../../../components/restaurant/kitchen';
import '../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/kitchen` — the kitchen display. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <KitchenDisplay locale={locale} surface="app" />;
}
