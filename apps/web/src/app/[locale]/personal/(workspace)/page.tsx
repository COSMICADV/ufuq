import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { PersonalHome } from '../../../../components/personal/personal-screens';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export const metadata: Metadata = { title: '1to1OS Personal' };

export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PersonalHome locale={locale} />;
}
