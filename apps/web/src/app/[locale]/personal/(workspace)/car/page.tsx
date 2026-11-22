import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { CarScreen } from '../../../../../components/personal/car/car-screen';
import '../../../../../styles/finance.css';
import '../../../../../styles/health.css';
import '../../../../../styles/car.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${createTranslator(locale)('personal.nav.car')} · 1to1OS Personal` };
}

export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <CarScreen locale={locale} />;
}
