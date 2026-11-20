import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { ResetPassword } from '../../../components/auth/reset-password';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: `${createTranslator(locale)('reset_password.title')} · 1to1OS` };
}

/** `/{locale}/reset-password#token=…` — where the reset email lands. */
export default async function ResetPasswordPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return (
    <main className="auth-page">
      <ResetPassword locale={locale} />
    </main>
  );
}
