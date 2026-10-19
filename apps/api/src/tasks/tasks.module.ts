/**
 * Phase 7 — tasks (DOCUMENT 25 Phase 7).
 *
 * `AuthModule` is imported for `AuditDispatcher`, which every write here records
 * through rather than duplicating (DOCUMENT 27 RULE 6). Overdue is derived on
 * read (DOCUMENT 13 rule 1); the only background work is Phase 15's hourly
 * scan (`task-jobs.ts`) that publishes the overdue and deadline-approaching
 * moments for notification. `TASK_EVENT_SINK` is provided by the global
 * notifications module.
 *
 * `GoalsCoreModule` (Phase 8) is imported for the goal ledger: DOCUMENT 13
 * rule 8 has a task change recalculate its Task goal in the same transaction.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { GoalsCoreModule } from '../goals/goals-core.module.js';

import { TaskEventPublisher } from './task-events.js';
import { TaskDeadlineScanner, TaskJobsScheduler } from './task-jobs.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

export interface TasksModuleOptions {
  readonly scheduler: boolean;
}

@Module({})
export class TasksModule {
  static register(options: TasksModuleOptions): DynamicModule {
    return {
      module: TasksModule,
      imports: [AuthModule, GoalsCoreModule],
      controllers: [TasksController],
      providers: [
        TasksService,
        TaskEventPublisher,
        TaskDeadlineScanner,
        ...(options.scheduler ? [TaskJobsScheduler] : []),
      ],
      exports: [TaskDeadlineScanner],
    };
  }
}
