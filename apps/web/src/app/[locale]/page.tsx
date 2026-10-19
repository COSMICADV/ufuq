import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { PublicSite, publicMetadata } from '../../components/public/public-site';
type Props = { readonly params: Promise<{ readonly locale: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? publicMetadata(locale, 'home') : {};
}
export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PublicSite locale={locale} page="home" />;
}
