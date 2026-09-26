import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { AcceptInvitation } from '../../../components/employees/accept-invitation';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/{locale}/accept-invitation` — DOCUMENT 04 A4, public. The emailed link
 * names the recipient's language in its path, so the page opens in the right
 * direction without asking.
 */
export default async function AcceptInvitationPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <main className="auth-page">
      <AcceptInvitation locale={locale} />
    </main>
  );
}
