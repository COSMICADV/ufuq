import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { MenuManager } from '../../../../../components/restaurant/menu-manager';
import '../../../../../styles/restaurant.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/restaurant/menu` — the visual menu. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <MenuManager locale={locale} surface="admin" />;
}
