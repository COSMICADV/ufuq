'use client';

import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';

/**
 * The slice of `GET /auth/me` the employees screens read — DOCUMENT 08 §4.1.
 *
 * Permissions decide what is *rendered* (DOCUMENT 09 §5); every action is
 * authorised again by the API. The company timezone is what dates are shown
 * in, never the browser's (DOCUMENT 11 §9).
 */
export interface SessionView {
  readonly permissions: ReadonlySet<string>;
  readonly timeZone: string;
  /** DOCUMENT 12 rule 13 — this company's attendance correction window. */
  readonly correctionWindowDays: number;
  /** The caller's own employee record, or null (the seeded first admin has none). */
  readonly employeeId: string | null;
}

interface MePayload {
  readonly company: { readonly timezone: string; readonly correctionWindowDays: number };
  readonly permissions: readonly { readonly key: string; readonly scope: string }[];
  readonly employee: { readonly id: string } | null;
}

export async function loadSession(locale: Locale, signal: AbortSignal): Promise<SessionView> {
  const me = await fetchOne<MePayload>('/auth/me', { locale, signal });
  return {
    permissions: new Set(me.permissions.map((permission) => permission.key)),
    timeZone: me.company.timezone,
    correctionWindowDays: me.company.correctionWindowDays,
    employeeId: me.employee?.id ?? null,
  };
}
