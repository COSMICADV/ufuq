/** Sends the password-reset link; the token is issued by `PasswordService`. */

import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@ufuq/config';

import { APP_ENV } from '../app.tokens.js';

import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';
import { buildResetMessage } from './reset-message.js';
import type { ResetMessageInput } from './reset-message.js';

export type ResetDelivery = Omit<ResetMessageInput, 'webOrigin'>;

@Injectable()
export class ResetMailer {
  constructor(
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  async send(delivery: ResetDelivery): Promise<void> {
    await this.transport.send(buildResetMessage({ ...delivery, webOrigin: this.env.webOrigin }));
  }
}
