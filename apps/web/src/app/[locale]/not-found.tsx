import { createTranslator, DEFAULT_LOCALE } from '@ufuq/i18n';

/**
 * The not-found page renders outside the route's params, so it answers in the
 * default language. A localised 404 arrives with the public site in Phase 16.
 */
export default function NotFound(): React.JSX.Element {
  const t = createTranslator(DEFAULT_LOCALE);
  return (
    <main className="shell">
      <h1>{t('error.not_found')}</h1>
    </main>
  );
}
