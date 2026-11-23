'use client';

import type { Locale } from '@ufuq/i18n';
import { useEffect, useState } from 'react';

import { loadIdentity, logoUrl } from '../../lib/brand';
import type { Identity } from '../../lib/brand';

/** The company's identity, kept current when any screen saves a change. */
export function useIdentity(locale: Locale, enabled = true): Identity | null {
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    loadIdentity(locale).then(
      (value) => {
        if (alive) setIdentity(value);
      },
      () => {
        // No identity is a safe answer: the company name stays.
      },
    );
    const onChange = (event: Event): void => {
      setIdentity((event as CustomEvent<Identity>).detail);
    };
    window.addEventListener('ufuq:identity', onChange);
    return () => {
      alive = false;
      window.removeEventListener('ufuq:identity', onChange);
    };
  }, [locale, enabled]);
  return identity;
}

/** An object URL for the logo (or its thermal copy), released when it changes. */
export function useLogoUrl(locale: Locale, identity: Identity | null, variant: 'main' | 'thermal' = 'main'): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const version = identity?.logo?.version ?? null;
  const available = variant === 'thermal' ? identity?.logo?.has_thermal === true : (identity?.logo ?? null) !== null;
  useEffect(() => {
    if (version === null || !available) {
      setUrl(null);
      return;
    }
    let made: string | null = null;
    let alive = true;
    logoUrl(locale, variant, version).then(
      (value) => {
        if (alive) {
          made = value;
          setUrl(value);
        } else URL.revokeObjectURL(value);
      },
      () => setUrl(null),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [locale, variant, version, available]);
  return url;
}
