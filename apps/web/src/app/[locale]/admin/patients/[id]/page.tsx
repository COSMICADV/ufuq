import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { PatientProfile } from '../../../../../components/medical/patient-profile';
import '../../../../../styles/medical.css';

interface PageProps {
  readonly params: Promise<{ readonly locale: string; readonly id: string }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/admin/patients/:id` — one patient's file; the API answers 404 to anyone it does not reach. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale, id } = await params;
  if (!isLocale(locale) || !UUID.test(id)) notFound();
  return <PatientProfile locale={locale} surface="admin" patientId={id} />;
}
