import { notFound } from 'next/navigation';
import { createTranslator, isLocale } from '@ufuq/i18n';

import { IdentitySettings } from '../../../../../components/brand/identity-settings';
import { SettingsHeading, SettingsShell } from '../../../../../components/settings/settings-shell';
import '../../../../../styles/brand.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/settings/identity` — Settings → Business Identity. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = createTranslator(locale);
  return (
    <SettingsShell locale={locale} section="identity">
      <SettingsHeading title={t('brand.title')} description={t('brand.description')} />
      <IdentitySettings locale={locale} />
    </SettingsShell>
  );
}
