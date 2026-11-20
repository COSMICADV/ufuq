import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { AccountsScreen } from '../../../../../../components/personal/finance/accounts-screen';
import '../../../../../../styles/finance.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = createTranslator(locale);
  return { title: `${t('finance.tabs.accounts')} · ${t('personal.nav.expenses')} · 1to1OS Personal` };
}

export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <AccountsScreen locale={locale} />;
}
