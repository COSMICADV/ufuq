'use client';

import { useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { sendNoContent } from '../lib/api-client';
import { publicPath } from '../lib/public-content';

/**
 * Ends this session and returns to the sign-in page. A full page load, not a
 * client-side navigation, so nothing the previous account loaded stays in
 * memory — which is what makes switching between an owner's and an
 * employee's account in the same browser safe.
 */
export function SignOutButton({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="sign-out"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // Even if the server cannot be reached, leave: the page is no use signed in.
        void sendNoContent('/auth/logout', { locale, method: 'POST' })
          .catch(() => undefined)
          .finally(() => {
            window.location.assign(publicPath(locale, 'login'));
          });
      }}
    >
      <svg
        viewBox="0 0 24 24"
        width="18"
        height="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="m16 17 5-5-5-5" />
        <path d="M21 12H9" />
      </svg>
      <span>{busy ? t('action.signing_out') : t('action.sign_out')}</span>
    </button>
  );
}
