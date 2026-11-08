import { Module } from '@nestjs/common';

import { SystemActorService } from '../attendance/system-actor.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { OwnerController } from './owner.controller.js';
import { OwnerKeyGuard } from './owner-key.guard.js';
import { OwnerService } from './owner.service.js';

/** Sign-up approval for the platform owner — see `owner.service.ts`. */
@Module({
  imports: [AuthModule],
  controllers: [OwnerController],
  providers: [OwnerService, OwnerKeyGuard, SystemActorService],
})
export class OwnerModule {}
