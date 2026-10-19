/**
 * Notification content — DOCUMENT 19 "Data" and rule 7.
 *
 * Both language variants are rendered when the notification is written and
 * both are stored, so a recipient who changes language reads their history in
 * the new one. The templates are the i18n catalogue's
 * (`notifications.content.*` and `notifications.summary.*`, DOCUMENT 27
 * RULE 24): no string is written here.
 *
 * Parameters are names, titles, dates and counts. **Never an amount**: a
 * salary, a deduction, a stock value or a quantity is behind the
 * authorization check of the screen the notification opens (rule 7: "تم
 * اعتماد راتبك" — not the amount). `NotificationParams` admits only strings
 * the rules build from identifiers and labels; the rules never pass a money
 * field.
 */

import { createTranslator } from '@ufuq/i18n';
import type { NotificationType } from '@ufuq/db';

/** A value that differs by language (a leave type's name), or the same in both (a person's name). */
export type LocalizedValue = string | { readonly ar: string; readonly en: string };
export type NotificationParams = Readonly<Record<string, LocalizedValue>>;

export interface NotificationContent {
  readonly titleAr: string;
  readonly titleEn: string;
  readonly bodyAr: string;
  readonly bodyEn: string;
}

const TITLE_MAX = 300;
const BODY_MAX = 1000;

const AR = createTranslator('ar');
const EN = createTranslator('en');

function valuesFor(params: NotificationParams, locale: 'ar' | 'en'): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : value[locale],
    ]),
  );
}

/** Cut at a character boundary, never mid-surrogate, with an ellipsis. */
function fit(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join('')}…`;
}

function render(key: string, params: NotificationParams): NotificationContent {
  const ar = valuesFor(params, 'ar');
  const en = valuesFor(params, 'en');
  return {
    titleAr: fit(AR(`${key}.title`, ar), TITLE_MAX),
    titleEn: fit(EN(`${key}.title`, en), TITLE_MAX),
    bodyAr: fit(AR(`${key}.body`, ar), BODY_MAX),
    bodyEn: fit(EN(`${key}.body`, en), BODY_MAX),
  };
}

/**
 * One notification's content. `variant` picks a wording of the same type —
 * a goal milestone told to its owner or to their manager, a request approved
 * or rejected.
 */
export function contentFor(
  type: NotificationType,
  params: NotificationParams,
  variant?: string,
): NotificationContent {
  return render(`notifications.content.${variant ?? type}`, params);
}

/** DOCUMENT 19 rule 4 — the summary that replaces a burst of one type. */
export function summaryContentFor(type: NotificationType, count: number): NotificationContent {
  return render(`notifications.summary.${type}`, { count: String(count) });
}
