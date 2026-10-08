/**
 * Phase 10 — leave (DOCUMENT 25 Phase 10, DOCUMENT 16).
 *
 * Registered with the environment because `POST /leave-requests` may carry
 * a file: Multer is configured with exactly the limits `/attachments` uses
 * (`uploadMulterOptions`), plus room for the request's own fields. The
 * scheduler is registered only when asked for, as in the attendance and goal
 * modules; a test drives `LeaveCarryOverService` directly.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '@ufuq/config';

import { uploadMulterOptions } from '../attachments/upload-limits.js';
import { SystemActorService } from '../attendance/system-actor.service.js';
import { AuthModule } from '../auth/auth.module.js';

import { LeaveCarryOverService } from './leave-carry-over.service.js';
import { LeaveCoreModule } from './leave-core.module.js';
import { LeaveScheduler } from './leave-jobs.js';
import {
  LeaveBalancesController,
  LeaveRequestsController,
  LeaveTypesController,
} from './leave.controller.js';
import { LeaveTypesService } from './leave-types.service.js';

export interface LeaveModuleOptions {
  readonly scheduler: boolean;
}

/** `leave_type_id`, `start_date`, `end_date`, `reason`. */
const LEAVE_FORM_FIELDS = 4;

@Module({})
export class LeaveModule {
  static register(env: Env, options: LeaveModuleOptions): DynamicModule {
    return {
      module: LeaveModule,
      imports: [
        AuthModule,
        LeaveCoreModule,
        MulterModule.register(uploadMulterOptions(env, LEAVE_FORM_FIELDS)),
      ],
      controllers: [LeaveTypesController, LeaveBalancesController, LeaveRequestsController],
      providers: [
        LeaveTypesService,
        LeaveCarryOverService,
        SystemActorService,
        ...(options.scheduler ? [LeaveScheduler] : []),
      ],
      exports: [LeaveCarryOverService],
    };
  }
}
