import type { MailMessage } from '../mail/mail-transport.js';
import type { ContactDto } from './public.dto.js';

export function contactMessage(to: string, dto: ContactDto): MailMessage {
  const rows = [
    ['نوع الاستفسار / Enquiry', dto.enquiry_type],
    ['الاسم / Name', dto.name],
    ['الشركة / Company', dto.company],
    ['الهاتف / Phone', dto.phone],
    ['البريد / Email', dto.email],
    ['الرسالة / Message', dto.message],
  ];
  const escape = (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  return {
    to,
    replyTo: dto.email,
    subject: 'أُفق — استفسار / UFUQ enquiry',
    text: rows.map(([label, value]) => `${label ?? ''}: ${value ?? ''}`).join('\n\n'),
    html:
      '<!doctype html><html lang="ar" dir="rtl"><body><h1>استفسار / Enquiry</h1>' +
      rows
        .map(
          ([label, value]) =>
            `<p><strong>${escape(label ?? '')}</strong></p><p dir="auto" style="white-space:pre-wrap">${escape(value ?? '')}</p>`,
        )
        .join('') +
      '</body></html>',
  };
}
