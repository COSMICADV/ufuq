/**
 * Outbound mail — approved Phase 5 SMTP for authentication, extended by the
 * approved Phase 16 contact decision to public contact delivery. DOCUMENT 09 §6 requires the invitation to reach
 * the employee by email; DOCUMENT 24 keeps email *notifications* in FUTURE,
 * and nothing here is a notification channel. Contact uses CONTACT_TO and a
 * validated Reply-To; the sender always comes from application configuration.
 *
 * The interface is what services depend on, so the delivery mechanism is a
 * provider decision in one module rather than an import in every caller — and
 * so the e2e suite can capture the message a real SMTP relay would receive.
 */

export interface MailMessage {
  readonly to: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/** DI token for the process-wide {@link MailTransport}. */
export const MAIL_TRANSPORT = Symbol('ufuq.api.mail-transport');
