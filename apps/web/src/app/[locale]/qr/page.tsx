import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';

interface PageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

/**
 * `/qr` — QR Studio is hidden from 1to1OS for now. Its page sends visitors to
 * the business workspace instead.
 *
 * Only the screen is closed: codes already printed keep working (`/q/[slug]`),
 * and the API and the stored codes are untouched. To bring the studio back,
 * render `QrShell` + `QrStudio` (components/qr) here again and restore its
 * menu entry in `product-shell.tsx`.
 */
export default async function Page({ params }: PageProps): Promise<never> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  redirect(`/${locale}/admin`);
}
