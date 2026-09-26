import { createTranslator, isLocale } from '@ufuq/i18n';
import { notFound } from 'next/navigation';

import { DesignSystemShowcase } from '../../components/design-system-showcase';
import { LanguageSwitch } from '../../components/language-switch';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * The application shell — DOCUMENT 25 Phase 1, "base layout shell".
 *
 * It carries no feature. Its job is to prove that the application boots, reads
 * its language from the route, and switches language and direction. The
 * marketing pages (DOCUMENT 23), the admin experience and the employee
 * experience (DOCUMENT 03) are later phases and are not stubbed here.
 */
export default async function HomePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }

  const t = createTranslator(locale);

  return (
    <>
      <LanguageSwitch
        locale={locale}
        label={t('language.switch')}
        names={{ ar: t('language.ar'), en: t('language.en') }}
      />
      <DesignSystemShowcase locale={locale} />
    </>
  );
}
