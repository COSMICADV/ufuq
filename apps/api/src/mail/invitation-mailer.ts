/**
 * Sends an invitation — the delivery half of DOCUMENT 09 §6. The token itself
 * is issued, hashed and stored by `InvitationService`; this class only builds
 * the message and hands it to the transport.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@ufuq/config';

import { APP_ENV } from '../app.tokens.js';

import { buildInvitationMessage } from './invitation-message.js';
import type { InvitationMessageInput } from './invitation-message.js';
import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';

export type InvitationDelivery = Omit<InvitationMessageInput, 'webOrigin'>;

@Injectable()
export class InvitationMailer {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async send(delivery: InvitationDelivery): Promise<void> {
    await this.transport.send(
      buildInvitationMessage({ ...delivery, webOrigin: this.env.webOrigin }),
    );
  }
}
