import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { publicMetadata } from '../../../components/public/public-site';
import { LandingPage } from '../../../components/public/landing-page';
import '../../../styles/landing.css';

/** The company site: what used to be the home page, now one door of two. */
type Props = { readonly params: Promise<{ readonly locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const base = publicMetadata(locale, 'home');
  const path = `${locale === 'ar' ? '' : '/en'}/business`;
  return {
    ...base,
    title: '1to1OS Business',
    alternates: {
      canonical: path,
      languages: { ar: '/business', en: '/en/business', 'x-default': '/business' },
    },
  };
}

export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <LandingPage locale={locale} />;
}
