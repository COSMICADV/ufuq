import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { publicMetadata } from '../../components/public/public-site';
import { LandingPage } from '../../components/public/landing-page';
import '../../styles/landing.css';
type Props = { readonly params: Promise<{ readonly locale: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? publicMetadata(locale, 'home') : {};
}
/** The home page is the standalone landing design; the other public pages keep PublicSite. */
export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <LandingPage locale={locale} />;
}
