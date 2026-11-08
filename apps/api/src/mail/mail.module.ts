/**
 * Mail — approved Phase 5 decision (SMTP for transactional authentication
 * mail). Global, like `DbModule` and `RedisModule`: a connection the process
 * holds once, not something each feature module constructs.
 */

import { Inject, Injectable, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@ufuq/config';

import { InvitationMailer } from './invitation-mailer.js';
import { MAIL_TRANSPORT } from './mail-transport.js';
import type { MailTransport } from './mail-transport.js';
import { ResendMailTransport } from './resend-mail-transport.js';
import { SmtpMailTransport } from './smtp-mail-transport.js';
import { SignupMailer } from './signup-mailer.js';

@Injectable()
class MailLifecycle implements OnModuleDestroy {
  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  onModuleDestroy(): void {
    if (this.transport instanceof SmtpMailTransport) {
      this.transport.close();
    }
  }
}

@Module({})
export class MailModule {
  static register(env: Env): DynamicModule {
    return {
      module: MailModule,
      global: true,
      providers: [
        {
          provide: MAIL_TRANSPORT,
          useFactory: (): MailTransport =>
            env.mail.resendApiKey
              ? new ResendMailTransport(env.mail.resendApiKey, env.mail.from)
              : new SmtpMailTransport(env.mail),
        },
        MailLifecycle,
        InvitationMailer,
        SignupMailer,
      ],
      exports: [MAIL_TRANSPORT, InvitationMailer, SignupMailer],
    };
  }
}
