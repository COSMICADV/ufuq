/**
 * Phase 6 — attendance (DOCUMENT 25 Phase 6).
 *
 * `AuthModule` is imported for `AuditDispatcher`, which every write here records
 * through rather than duplicating (DOCUMENT 27 RULE 6).
 *
 * The scheduler is registered only when asked for. A test suite that boots the
 * application wants the endpoints, not a worker opening a second Redis
 * connection and a repeatable job against the test's Redis — so
 * `register({ scheduler: false })` builds the module without it, and the
 * generation service is still injectable for a test that drives a run
 * directly.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PayrollGuardModule } from '../payroll/payroll-guard.module.js';

import { AttendanceController } from './attendance.controller.js';
import { AttendanceGenerationService } from './attendance-generation.service.js';
import { AttendanceScheduler } from './attendance-jobs.js';
import { AttendanceService } from './attendance.service.js';
import { CorrectionsController } from './corrections.controller.js';
import { CorrectionsService } from './corrections.service.js';
import { EmployeeAttendanceController } from './employee-attendance.controller.js';
import { SystemActorService } from './system-actor.service.js';

export interface AttendanceModuleOptions {
  /** False in tests and in any process that must not run background work. */
  readonly scheduler: boolean;
}

@Module({})
export class AttendanceModule {
  static register(options: AttendanceModuleOptions): DynamicModule {
    return {
      module: AttendanceModule,
      imports: [AuthModule, PayrollGuardModule],
      controllers: [AttendanceController, CorrectionsController, EmployeeAttendanceController],
      providers: [
        AttendanceService,
        CorrectionsService,
        AttendanceGenerationService,
        SystemActorService,
        ...(options.scheduler ? [AttendanceScheduler] : []),
      ],
      exports: [AttendanceService, AttendanceGenerationService, SystemActorService],
    };
  }
}
