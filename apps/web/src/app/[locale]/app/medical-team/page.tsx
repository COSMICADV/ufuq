import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { MedicalTeam } from '../../../../components/medical/medical-team';
import '../../../../styles/medical.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/medical-team` — the medical team and each member's permissions. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <MedicalTeam locale={locale} />;
}
