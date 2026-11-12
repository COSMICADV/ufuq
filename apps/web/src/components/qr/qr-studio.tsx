'use client';

/**
 * QR Studio — the 1to1QR wizard, designs and live preview, inside 1to1OS.
 *
 * The studio itself is the ported 1to1QR app (`public/qr-studio/studio.html`). It runs in a
 * same-origin frame so its own styles and scripts stay apart from the product screens, and it
 * reads the 1to1OS theme from this page, so it changes with the theme picker. It is given the
 * signed-in account and the screen's language; sign-in, language and theme are 1to1OS's.
 */
import { useCallback } from 'react';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
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

  if (me.state.status !== 'ready') {
    return (
      <section className="qr-studio" aria-busy={me.state.status === 'loading'}>
        <p className="qr-studio__status">
          {me.state.status === 'loading'
            ? ar
              ? 'جاري تحميل استوديو QR…'
              : 'Loading QR Studio…'
            : ar
              ? 'تعذر تحميل استوديو QR. حدّث الصفحة وحاول تاني.'
              : 'QR Studio could not load. Refresh the page and try again.'}
        </p>
      </section>
    );
  }

  const { user, company } = me.state.value;
  const query = new URLSearchParams({
    lang: locale,
    u: user.id,
    email: user.email,
    name: company.name,
  });
  return (
    <section className="qr-studio">
      <iframe
        className="qr-studio__frame"
        title={title}
        src={`/qr-studio/studio.html?${query.toString()}`}
        allow="clipboard-write; camera"
      />
    </section>
  );
}
