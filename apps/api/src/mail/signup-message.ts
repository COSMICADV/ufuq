/**
 * The two sign-up approval emails. Pure, so their content and escaping can be
 * asserted without a mail server.
 *
 *   - {@link buildSignupRequestMessage}: tells the platform owner a company
 *     asked to join, with a button to the owner page. The owner key travels in
 *     the URL *fragment*, which is never sent to a server or in a `Referer`
 *     (DOCUMENT 20 §6) — the page reads it in the browser. The link opens the
 *     review page; approving still takes a click there, so a mail scanner that
 *     follows links cannot approve anyone.
 *   - {@link buildSignupApprovedMessage}: tells the new administrator they can
 *     sign in.
 *
 * Every tenant-supplied value written into HTML is escaped.
 */

import { createTranslator, documentAttributes } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import type { MailMessage } from './mail-transport.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BUTTON_STYLE =
  'display:inline-block;padding:12px 22px;border-radius:10px;background:#E2C0A8;color:#0F172A;font-weight:700;text-decoration:none';
const CARD_STYLE =
  'max-width:560px;margin:0 auto;padding:28px;border-radius:16px;background:#0F172A;color:#F1F5F9;font-family:Inter,Segoe UI,Arial,sans-serif';

export interface SignupRequestInput {
  readonly to: string;
  readonly webOrigin: string;
  readonly ownerKey: string | null;
  readonly companyId: string;
  readonly companyName: string;
  readonly adminName: string;
  readonly adminEmail: string;
  readonly adminPhone: string;
  readonly employeeCountRange: string;
  readonly requestedAt: Date;
}

/** `/en/owner#key=…&request=…` on the web origin. */
export function ownerReviewLink(
  webOrigin: string,
  ownerKey: string | null,
  companyId: string,
): string {
  const url = new URL('/en/owner', webOrigin);
  const hash = new URLSearchParams();
  if (ownerKey) hash.set('key', ownerKey);
  hash.set('request', companyId);
  url.hash = hash.toString();
  return url.toString();
}

export function buildSignupRequestMessage(input: SignupRequestInput): MailMessage {
  const link = ownerReviewLink(input.webOrigin, input.ownerKey, input.companyId);
  const rows: [string, string][] = [
    ['Company / الشركة', input.companyName],
    ['Administrator / المسؤول', input.adminName],
    ['Email / البريد', input.adminEmail],
    ['Phone / الهاتف', input.adminPhone],
    ['Employees / عدد الموظفين', input.employeeCountRange],
    [
      'Requested / وقت الطلب',
      input.requestedAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    ],
  ];
  const text = [
    'Someone requested access to 1to1OS. Review and approve it:',
    'طلب جديد للانضمام إلى 1to1OS. راجعه ووافق عليه من الرابط:',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Review & approve / مراجعة وموافقة: ${link}`,
  ].join('\n');
  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#020617">',
    `<div style="${CARD_STYLE}">`,
    '<p style="margin:0 0 4px;color:#E2C0A8;font-size:12px;letter-spacing:.1em;text-transform:uppercase">1to1OS · Access request</p>',
    `<h1 style="margin:0 0 6px;font-size:22px;color:#fff">${escapeHtml(input.companyName)} wants to join</h1>`,
    '<p style="margin:0 0 20px;color:#94A3B8" dir="rtl">طلب جديد للانضمام إلى 1to1OS</p>',
    '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:14px">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#94A3B8;border-bottom:1px solid #1E293B">${escapeHtml(label)}</td>` +
        `<td style="padding:8px 0;color:#F1F5F9;border-bottom:1px solid #1E293B;text-align:right" dir="auto">${escapeHtml(value)}</td></tr>`,
    ),
    '</table>',
    `<p style="margin:0 0 8px"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">Review &amp; approve · مراجعة وموافقة</a></p>`,
    '<p style="margin:16px 0 0;color:#64748B;font-size:12px">The button opens your owner page, where you approve or reject the request. Do not forward this email — the link unlocks your owner page.</p>',
    '</div></body></html>',
  ].join('');
  return {
    to: input.to,
    replyTo: input.adminEmail,
    subject: `New 1to1OS access request: ${input.companyName}`,
    text,
    html,
  };
}

export interface SignupApprovedInput {
  readonly to: string;
  readonly locale: Locale;
  readonly webOrigin: string;
  readonly name: string;
  readonly companyName: string;
}

export function buildSignupApprovedMessage(input: SignupApprovedInput): MailMessage {
  const t = createTranslator(input.locale);
  const values = { name: input.name, company: input.companyName };
  const link = new URL(`/${input.locale}/login`, input.webOrigin).toString();
  const greeting = t('mail.signup_approved.greeting', values);
  const body = t('mail.signup_approved.body', values);
  const action = t('mail.signup_approved.action');
  const { lang, dir } = documentAttributes(input.locale);
  return {
    to: input.to,
    subject: t('mail.signup_approved.subject'),
    text: [greeting, body, `${action}: ${link}`].join('\n\n'),
    html: [
      `<!doctype html><html lang="${lang}" dir="${dir}"><body style="margin:0;padding:24px;background:#020617">`,
      `<div style="${CARD_STYLE}">`,
      `<p style="margin:0 0 12px;color:#fff;font-size:18px;font-weight:700">${escapeHtml(greeting)}</p>`,
      `<p style="margin:0 0 24px;color:#CBD5E1">${escapeHtml(body)}</p>`,
      `<p style="margin:0"><a href="${escapeHtml(link)}" style="${BUTTON_STYLE}">${escapeHtml(action)}</a></p>`,
      '</div></body></html>',
    ].join(''),
  };
}
