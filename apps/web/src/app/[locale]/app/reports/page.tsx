import { notFound } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

import { MyLatestMonthlyReport } from '../../../../components/reports/my-monthly-report';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/app/reports` — opens last month's report. */
export default async function Page({ params }: PageProps): Promise<React.JSX.Element> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  return <MyLatestMonthlyReport locale={locale} />;
}
