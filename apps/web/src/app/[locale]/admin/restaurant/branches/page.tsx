import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { RestaurantBranches } from '../../../../../components/restaurant/setup';
import '../../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/restaurant/branches` — branches. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <RestaurantBranches locale={locale} surface="admin" />;
}
