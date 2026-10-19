/**
 * The SMTP implementation of {@link MailTransport}.
 *
 * Configuration comes from `@ufuq/config` (validated once at bootstrap,
 * DOCUMENT 20 §11). The message body is never logged: an invitation email
 * carries a single-use token, and DOCUMENT 20 §8 keeps tokens out of logs.
 */

import type { Env } from '@ufuq/config';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import type { MailMessage, MailTransport } from './mail-transport.js';

export class SmtpMailTransport implements MailTransport {
  private readonly transporter: Transporter;

  constructor(private readonly config: Env['mail']) {
    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      ...(config.smtpUser !== null && config.smtpPassword !== null
        ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
        : {}),
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.from,
      to: message.to,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }

  close(): void {
    this.transporter.close();
  }
}
