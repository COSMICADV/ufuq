/**
 * The invitation email — DOCUMENT 09 §6, DOCUMENT 05 FLOW 02/03.
 *
 * Pure, so its two security properties can be asserted without a mail server:
 *
 *   1. The token travels in the URL *fragment*, not the query string.
 *      DOCUMENT 20 §6 keeps sensitive data out of query strings and referrer
 *      headers; a fragment is never sent to a server or in a `Referer`. The
 *      acceptance page reads it in the browser and posts it to
 *      `POST /auth/accept-invitation`.
 *   2. Every value written into the HTML part is escaped. A company name is
 *      tenant-supplied text, and an email client is an HTML renderer.
 *
 * Both languages come from the one catalogue (DOCUMENT 27 RULE 25), and the
 * expiry is shown in the company's time zone, never the server's (DOCUMENT 11
 * §9).
 */

import { createTranslator, documentAttributes, formatDateTime } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { MailMessage } from './mail-transport.js';

export interface InvitationMessageInput {
  readonly to: string;
  readonly locale: Locale;
  readonly token: string;
  readonly firstName: string;
  readonly companyName: string;
  readonly expiresAt: Date;
  /** The company's IANA zone. */
  readonly timeZone: string;
  /** Where the web application lives (`WEB_ORIGIN`). */
  readonly webOrigin: string;
}

/** `/{locale}/accept-invitation#token=…` on the web origin. */
export function invitationLink(webOrigin: string, locale: Locale, token: string): string {
  const url = new URL(`/${locale}/accept-invitation`, webOrigin);
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

export function buildInvitationMessage(input: InvitationMessageInput): MailMessage {
  const t = createTranslator(input.locale);
  const values = {
    name: input.firstName,
    company: input.companyName,
    expiry: formatDateTime(input.expiresAt, { locale: input.locale, timeZone: input.timeZone }),
  };
  const link = invitationLink(input.webOrigin, input.locale, input.token);

  const greeting = t('mail.invitation.greeting', values);
  const body = t('mail.invitation.body', values);
  const action = t('mail.invitation.action');
  const expiry = t('mail.invitation.expiry', values);
  const ignore = t('mail.invitation.ignore');

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

  return { to: input.to, subject: t('mail.invitation.subject', values), text, html };
}
