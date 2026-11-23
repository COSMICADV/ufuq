import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { BrandingSetup } from '../../../../../components/brand/branding-setup';
import '../../../../../styles/brand.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/setup/branding` — the Restaurant Branding onboarding step. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <BrandingSetup locale={locale} />;
}
