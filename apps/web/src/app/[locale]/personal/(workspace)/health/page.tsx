import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { HealthOverviewScreen } from '../../../../../components/personal/health/health-overview';
import '../../../../../styles/finance.css';
import '../../../../../styles/health.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${createTranslator(locale)('personal.nav.health')} · 1to1OS Personal` };
}

export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <HealthOverviewScreen locale={locale} />;
}
