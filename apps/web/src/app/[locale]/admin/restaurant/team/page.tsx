import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { RestaurantTeam } from '../../../../../components/restaurant/setup';
import '../../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/restaurant/team` — the restaurant team. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RestaurantTeam locale={locale} surface="admin" />;
}
