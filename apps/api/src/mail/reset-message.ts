/**
 * The password-reset email. Pure, like the invitation email, and with the
 * same two properties: the token travels in the URL *fragment* (never sent to
 * a server or in a `Referer`), and every value written into the HTML part is
 * escaped. The expiry is shown in the account's company time zone.
 */

import { createTranslator, documentAttributes, formatDateTime } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { MailMessage } from './mail-transport.js';

export interface ResetMessageInput {
  readonly to: string;
  readonly locale: Locale;
  readonly token: string;
  readonly expiresAt: Date;
  /** The account's company IANA zone. */
  readonly timeZone: string;
  /** Where the web application lives (`WEB_ORIGIN`). */
  readonly webOrigin: string;
}

/** `/{locale}/reset-password#token=…` on the web origin. */
export function resetLink(webOrigin: string, locale: Locale, token: string): string {
  const url = new URL(`/${locale}/reset-password`, webOrigin);
  url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildResetMessage(input: ResetMessageInput): MailMessage {
  const t = createTranslator(input.locale);
  const values = {
    expiry: formatDateTime(input.expiresAt, { locale: input.locale, timeZone: input.timeZone }),
  };
  const link = resetLink(input.webOrigin, input.locale, input.token);
  const greeting = t('mail.reset.greeting');
  const body = t('mail.reset.body');
  const action = t('mail.reset.action');
  const expiry = t('mail.reset.expiry', values);
  const ignore = t('mail.reset.ignore');

  const text = [greeting, body, `${action}: ${link}`, expiry, ignore].join('\n\n');
  const { lang, dir } = documentAttributes(input.locale);
  const paragraph = (value: string): string => `<p>${escapeHtml(value)}</p>`;
  const html = [
    `<!doctype html><html lang="${lang}" dir="${dir}"><body>`,
    paragraph(greeting),
    paragraph(body),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`,
    paragraph(expiry),
    paragraph(ignore),
    '</body></html>',
  ].join('');
  return { to: input.to, subject: t('mail.reset.subject'), text, html };
}
