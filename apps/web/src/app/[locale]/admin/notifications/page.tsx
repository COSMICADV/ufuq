import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { NotificationCenter } from '../../../../components/notifications/notification-center';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/admin/notifications` — the caller's own notification centre (DOCUMENT 04
 * C14, DOCUMENT 19). The same feed on either side: it is the user's, not the
 * side's.
 */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return <NotificationCenter locale={locale} />;
}
