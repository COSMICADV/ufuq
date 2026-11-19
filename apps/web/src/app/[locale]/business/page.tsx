import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { publicMetadata } from '../../../components/public/public-site';
import { BusinessPage } from '../../../components/public/business-page';
import '../../../styles/home.css';
import '../../../styles/business.css';

/** 1to1OS Business: the subscription and its sections, before signing up. */
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
      canonical: locale === 'ar' ? '/business' : '/en/business',
      languages: { ar: '/business', en: '/en/business', 'x-default': '/business' },
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
