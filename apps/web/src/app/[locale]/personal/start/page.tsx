import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { PersonalStart } from '../../../../components/personal/personal-start';
import '../../../../styles/personal.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${createTranslator(locale)('personal.start_title')} · 1to1OS` };
}

/** 1to1OS Personal sign-up, outside the workspace shell. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PersonalStart locale={locale} />;
}
