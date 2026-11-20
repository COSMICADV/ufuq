import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@ufuq/i18n';
import type { Metadata } from 'next';
import { PublicSite, publicMetadata } from '../../../components/public/public-site';
import { PUBLIC_PAGES } from '../../../lib/public-content';
import type { PublicPage } from '../../../lib/public-content';
type Props = {
  readonly params: Promise<{ readonly locale: string; readonly publicPage: string }>;
  readonly searchParams: Promise<{ readonly reset?: string }>;
};
/**
 * Marketing pages that no longer exist outside the product: features and prices
 * live inside the app, so these addresses lead back to the product choice.
 */
const INSIDE_ONLY: ReadonlySet<string> = new Set(['about', 'features', 'for-companies', 'pricing']);

export function generateStaticParams(): { publicPage: string }[] {
  return PUBLIC_PAGES.filter((p) => p !== 'home' && p !== 'login' && !INSIDE_ONLY.has(p)).map(
    (publicPage) => ({
      publicPage,
    }),
  );
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, publicPage } = await params;
  return isLocale(locale) && PUBLIC_PAGES.includes(publicPage as PublicPage)
    ? publicMetadata(locale, publicPage as PublicPage)
    : {};
}
export default async function Page({ params }: Props): Promise<React.JSX.Element> {
  const { locale, publicPage } = await params;
  if (
    !isLocale(locale) ||
    publicPage === 'home' ||
    !PUBLIC_PAGES.includes(publicPage as PublicPage)
  )
    notFound();
  if (INSIDE_ONLY.has(publicPage)) redirect(`/${locale}`);
  return <PublicSite locale={locale} page={publicPage as PublicPage} />;
}
