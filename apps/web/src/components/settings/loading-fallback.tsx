import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { Skeleton } from '../design-system';

/**
 * What a settings screen looks like before its client bundle has run.
 *
 * The same skeleton the screen itself shows while fetching, so the transition
 * from "not hydrated" to "loading data" is invisible — DOCUMENT 11 §2:
 * "skeletons matching the real layout", and never a full-page spinner.
 */
export function LoadingFallback({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="state-block" aria-label={t('state.loading')}>
      <Skeleton lines={6} />
    </div>
  );
}
