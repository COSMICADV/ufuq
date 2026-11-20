import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import {
  PersonalSectionScreen,
  PersonalSettings,
} from '../../../../../components/personal/personal-screens';
import { isPersonalSection } from '../../../../../lib/personal';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly section: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, section } = await params;
  if (!isLocale(locale) || !isPersonalSection(section)) return {};
  return { title: `${createTranslator(locale)(`personal.nav.${section}`)} · 1to1OS Personal` };
}

/** One Personal section; settings has its own screen. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, section } = await params;
  if (!isLocale(locale) || !isPersonalSection(section)) notFound();
  return section === 'settings' ? (
    <PersonalSettings locale={locale} />
  ) : (
    <PersonalSectionScreen locale={locale} section={section} />
  );
}
