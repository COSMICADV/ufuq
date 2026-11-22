import { notFound } from 'next/navigation';
import { createTranslator, isLocale, LOCALES } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { publicMetadata } from '../../../components/public/public-site';
import { BusinessPage } from '../../../components/public/business-page';
import '../../../styles/home.css';
import '../../../styles/business.css';

/**
 * 1to1OS Business: the subscription's sections, then "Choose your business
 * activity", whose Continue leads into sign-up with the activity chosen.
 * No prices are shown here.
 */
type Props = { readonly params: Promise<{ readonly locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = createTranslator(locale);
  const base = publicMetadata(locale, 'home');
  return {
    ...base,
    title: t('business.title'),
    description: t('business.description'),
    alternates: {
      canonical: `/${locale}/business`,
      languages: Object.fromEntries([...LOCALES.map((l) => [l, `/${l}/business`]), ['x-default', '/ar/business']]),
    },
    openGraph: {
      ...base.openGraph,
      title: t('business.title'),
      description: t('business.description'),
    },
  };
}

export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <BusinessPage locale={locale} />;
}
