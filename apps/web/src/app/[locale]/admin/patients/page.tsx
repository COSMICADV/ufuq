import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { PatientsList } from '../../../../components/medical/patients-list';
import '../../../../styles/medical.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/patients` — Business → Medical: the patients this person may open. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <PatientsList locale={locale} surface="admin" />;
}
