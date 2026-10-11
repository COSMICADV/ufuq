import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuditDispatcher, AUDIT_RETRY_QUEUE, BullMqAuditRetryQueue } from './audit-dispatcher.js';
import { AuditService } from './audit.service.js';
import { InvitationService } from './invitation.service.js';
import { PasswordService } from './password.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    AuditService,
    AuditDispatcher,
    { provide: AUDIT_RETRY_QUEUE, useClass: BullMqAuditRetryQueue },
    InvitationService,
    PasswordService,
    RateLimitService,
    SessionService,
  ],
  // `SessionService` is used directly by `SessionAuthGuard`, which is
  // registered application-wide in `app.module.ts` — outside this module.
  // `InvitationService` is shared with Phase 5's employee writes, which issue
  // the invitations this module accepts: one owner for the token lifecycle.
  // `AuditDispatcher` is the post-commit path to the same writer (DOCUMENT 21
  // §1–§3); Phase 10 Leave is its first user.
  exports: [SessionService, AuditService, AuditDispatcher, InvitationService],
})
export class AuthModule {}
