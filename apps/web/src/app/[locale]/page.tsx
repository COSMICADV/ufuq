import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { publicMetadata } from '../../components/public/public-site';
import { HomePage } from '../../components/public/home-page';
import '../../styles/home.css';

type Props = { readonly params: Promise<{ readonly locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = createTranslator(locale);
  const base = publicMetadata(locale, 'home');
  return {
    ...base,
    title: t('entry.title'),
    description: t('entry.description'),
    openGraph: { ...base.openGraph, title: t('entry.title'), description: t('entry.description') },
  };
}

export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <HomePage locale={locale} />;
}
