'use client';

import type { Locale } from '@ufuq/i18n';

import { displayName } from '../../lib/brand';
import type { Identity } from '../../lib/brand';

import { useIdentity, useLogoUrl } from './use-identity';

/**
 * The business's logo and name, as documents print them. Without a logo the
 * name stands alone — never a placeholder graphic.
 */
export function BrandMark({
  locale,
  identity: given,
  className,
}: {
  readonly locale: Locale;
  readonly identity?: Identity | null;
  readonly className?: string;
}): React.JSX.Element | null {
  const loaded = useIdentity(locale, given === undefined);
  const identity = given === undefined ? loaded : given;
  const logo = useLogoUrl(locale, identity ?? null);
  if (!identity) return null;
  const name = displayName(identity, locale);
  return (
    <span className={['brand-mark', className].filter(Boolean).join(' ')}>
      {logo ? <img src={logo} alt="" className="brand-mark__logo" /> : null}
      <span className="brand-mark__name">{name}</span>
    </span>
  );
}
