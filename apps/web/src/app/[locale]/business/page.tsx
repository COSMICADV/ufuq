import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

/**
 * 1to1OS Business opens the product itself: sign-in, with sign-up one link
 * away. The subscription, its sections and its prices are shown inside the app,
 * so the former marketing page (components/public/business-page.tsx) is no
 * longer routed; this address leads to sign-in.
 */
type Props = { readonly params: Promise<{ readonly locale: string }> };

export default async function Page({ params }: Props): Promise<never> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/${locale}/login`);
}
