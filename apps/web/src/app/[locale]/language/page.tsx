import type { Metadata } from 'next';

import { LanguagePage } from '../../../components/public/language-page';
import '../../../styles/home.css';

/**
 * The first screen of the site. Visitors reach it at `/`, which the proxy
 * rewrites here; the locale in the path only sets the document's defaults.
 */
export const metadata: Metadata = {
  title: '1to1OS',
  description:
    'Choose your language · اختار لغتك · Choisissez votre langue · Scegli la tua lingua · Wählen Sie Ihre Sprache',
};

export default function Page(): React.JSX.Element {
  return <LanguagePage />;
}
