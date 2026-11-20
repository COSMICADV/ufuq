import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { ReactNode } from 'react';

import { PersonalShell } from '../../../../components/personal/personal-shell';
import '../../../../styles/personal.css';

interface LayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly locale: string }>;
}

/** Every 1to1OS Personal screen sits in the Personal shell (the reference sidebar). */
export default async function Layout({
  children,
  params,
}: LayoutProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PersonalShell locale={locale}>{children}</PersonalShell>;
}
