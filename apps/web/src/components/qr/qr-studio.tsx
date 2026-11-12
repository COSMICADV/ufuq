'use client';

/**
 * QR Studio — the 1to1QR wizard, designs and live preview, inside 1to1OS.
 *
 * The studio itself is the ported 1to1QR app (`public/qr-studio/studio.html`). It runs in a
 * same-origin frame so its own styles and scripts stay apart from the product screens. The
 * screen around it is an ordinary 1to1OS screen — the same page heading every section has —
 * and the studio reads this page's theme tokens, so its chrome follows the product's design
 * and changes with the theme picker. It is given the signed-in account, the screen's language
 * and the API address; sign-in, language and theme are 1to1OS's, and the codes are saved
 * through the API's `/qr` endpoints.
 */
import { useCallback } from 'react';
import type { Locale } from '@ufuq/i18n';

import { API_BASE_PATH, API_ORIGIN, fetchOne } from '../../lib/api-client';
import { useResource } from '../settings/use-resource';

interface MePayload {
  readonly user: { readonly id: string; readonly email: string };
  readonly company: { readonly name: string };
}

export function QrStudio({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const ar = locale === 'ar';
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<MePayload>('/auth/me', { locale, signal }),
    [locale],
  );
  const me = useResource(load);
  const title = ar ? 'استوديو QR' : 'QR Studio';
  const description = ar
    ? 'اعمل أكواد QR بهوية شركتك، عدّل محتواها بعد الطباعة، وتابع المسحات.'
    : 'Create QR codes in your brand, change what they point to after printing, and follow the scans.';
  const heading = (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
    </header>
  );

  if (me.state.status !== 'ready') {
    return (
      <div className="qr-studio" aria-busy={me.state.status === 'loading'}>
        {heading}
        <p className="qr-studio__status">
          {me.state.status === 'loading'
            ? ar
              ? 'جاري تحميل استوديو QR…'
              : 'Loading QR Studio…'
            : ar
              ? 'تعذر تحميل استوديو QR. حدّث الصفحة وحاول تاني.'
              : 'QR Studio could not load. Refresh the page and try again.'}
        </p>
      </div>
    );
  }

  const { user, company } = me.state.value;
  const query = new URLSearchParams({
    lang: locale,
    u: user.id,
    email: user.email,
    name: company.name,
    // Where the studio saves codes and uploads files: the same API this screen uses.
    api: new URL(API_BASE_PATH, API_ORIGIN).toString(),
  });
  return (
    <div className="qr-studio">
      {heading}
      <iframe
        className="qr-studio__frame"
        title={title}
        src={`/qr-studio/studio.html?${query.toString()}`}
        allow="clipboard-write; camera"
      />
    </div>
  );
}
