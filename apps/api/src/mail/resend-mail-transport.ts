/**
 * {@link MailTransport} over Resend's HTTPS API (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Used instead of SMTP when `RESEND_API_KEY` is set: some hosts — Railway's
 * Free, Trial and Hobby plans among them — block outbound SMTP entirely, while
 * HTTPS always gets through. The message body is never logged (DOCUMENT 20 §8).
 */

import type { MailMessage, MailTransport } from './mail-transport.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export class ResendMailTransport implements MailTransport {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await this.fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Resend's error body names the problem (unverified domain, bad key…)
      // and never echoes the message, so it is safe to surface.
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend rejected the message (${response.status}): ${detail.slice(0, 300)}`);
    }
  }
}
