import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { OwnerRequests } from '../../../components/owner/owner-requests';
import '../../../styles/owner.css';

type Props = { readonly params: Promise<{ readonly locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = createTranslator(locale);
  return {
    title: `${t('owner.title')} | ${t('app.name')}`,
    robots: { index: false, follow: false },
  };
}

/** The platform owner's sign-up review page. Unlocked by the owner key, not a session. */
export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <OwnerRequests locale={locale} />;
}
