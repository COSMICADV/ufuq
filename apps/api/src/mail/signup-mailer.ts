/**
 * Sends the sign-up approval emails (see `signup-message.ts`). Both are
 * best-effort: a sign-up is saved, and an approval stands, whether or not the
 * email goes out — the owner page always shows the full list. A failure is a
 * log line, never an error the visitor sees.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Env } from '@ufuq/config';

import { APP_ENV } from '../app.tokens.js';

import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';
import { buildSignupApprovedMessage, buildSignupRequestMessage } from './signup-message.js';
import type { SignupApprovedInput, SignupRequestInput } from './signup-message.js';

@Injectable()
export class SignupMailer {
  private readonly logger = new Logger(SignupMailer.name);

  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /** Tell the platform owner a company asked to join. Returns whether it was sent. */
  async notifyOwner(
    request: Omit<SignupRequestInput, 'to' | 'webOrigin' | 'ownerKey'>,
  ): Promise<boolean> {
    const to = this.env.owner?.notifyTo ?? null;
    if (!to) {
      this.logger.warn('sign-up saved; OWNER_NOTIFY_TO is not set, so no owner email was sent');
      return false;
    }
    try {
      await this.transport.send(
        buildSignupRequestMessage({
          ...request,
          to,
          webOrigin: this.env.webOrigin,
          ownerKey: this.env.owner?.accessKey ?? null,
        }),
      );
      return true;
    } catch (error) {
      this.logger.error(`sign-up saved; the owner email failed: ${String(error)}`);
      return false;
    }
  }

  /** Tell a newly approved administrator they can sign in. Returns whether it was sent. */
  async notifyApproved(approved: Omit<SignupApprovedInput, 'webOrigin'>): Promise<boolean> {
    try {
      await this.transport.send(
        buildSignupApprovedMessage({ ...approved, webOrigin: this.env.webOrigin }),
      );
      return true;
    } catch (error) {
      this.logger.warn(`approval saved; the approval email failed: ${String(error)}`);
      return false;
    }
  }
}
