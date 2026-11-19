import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/** `/admin/qr` — QR Studio is hidden for now (see `/qr`); old links land on the workspace. */
export default async function Page({ params }: PageProps): Promise<never> {
  const { locale } = await params;
  if (!isLocale(locale)) {
    notFound();
  }
  redirect(`/${locale}/admin`);
}
