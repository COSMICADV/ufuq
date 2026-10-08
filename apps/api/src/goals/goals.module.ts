/**
 * Phase 8 — goals (DOCUMENT 25 Phase 8, DOCUMENT 14).
 *
 * The scheduler is registered only when asked for, exactly as in
 * `AttendanceModule`: a test suite boots the endpoints without a BullMQ worker
 * and drives `GoalLifecycleService` directly.
 *
 * `SystemActorService` is provided here as well as in the attendance module:
 * it is stateless, and the period-end job needs the same designated actor
 * (DOCUMENT 21 "Record content") for the audit records it writes.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { SystemActorService } from '../attendance/system-actor.service.js';
import { AuthModule } from '../auth/auth.module.js';

import { GoalsScheduler } from './goal-jobs.js';
import { GoalLifecycleService } from './goal-lifecycle.service.js';
import { GoalsController } from './goals.controller.js';
import { GoalsCoreModule } from './goals-core.module.js';
import { GoalsService } from './goals.service.js';

export interface GoalsModuleOptions {
  /** False in tests and in any process that must not run background work. */
  readonly scheduler: boolean;
}

@Module({})
export class GoalsModule {
  static register(options: GoalsModuleOptions): DynamicModule {
    return {
      module: GoalsModule,
      imports: [AuthModule, GoalsCoreModule],
      controllers: [GoalsController],
      providers: [
        GoalsService,
        GoalLifecycleService,
        SystemActorService,
        ...(options.scheduler ? [GoalsScheduler] : []),
      ],
      exports: [GoalLifecycleService],
    };
  }
}
