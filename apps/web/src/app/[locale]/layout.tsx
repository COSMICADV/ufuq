import { notFound } from 'next/navigation';
import { createTranslator, documentAttributes, isLocale, LOCALES } from '@ufuq/i18n';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '../../styles/globals.css';
import '../../styles/public.css';
import '../../styles/v2.css';

interface LocaleParams {
  readonly locale: string;
}

interface LocaleLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<LocaleParams>;
}

/** Both locales are prerendered. Neither is a runtime fallback for the other. */
export function generateStaticParams(): LocaleParams[] {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<LocaleParams>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    return {};
  }
  const t = createTranslator(locale);
  return { title: t('app.name'), description: t('app.tagline') };
}

/**
 * The root layout.
 *
 * `lang` and `dir` are derived from the path's locale by @ufuq/i18n and set in
 * this one place. No component below decides its own direction
 * (DOCUMENT 10 §9, DOCUMENT 27 RULE 24).
 */
export default async function LocaleLayout({
  children,
  params,
}: LocaleLayoutProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  const { lang, dir } = documentAttributes(locale);

  return (
    <html lang={lang} dir={dir}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Alexandria:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
