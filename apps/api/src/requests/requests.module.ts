/**
 * Phase 9 — the Requests Centre (DOCUMENT 25 Phase 9, DOCUMENT 08 §4.9).
 *
 * `CorrectionsService` is provided here as well as in the attendance module,
 * as `SystemActorService` is in the goals module: it is stateless, and the
 * Requests Centre decides an attendance row by delegating to it (OD-09) rather
 * than holding a second copy of its rules. `AttachmentsService` comes from the
 * global attachments module.
 *
 * `REQUEST_EVENT_SINK` is provided by the global notifications module
 * (Phase 15): nothing that submits or decides a request knows who is told.
 */

import { Module } from '@nestjs/common';

import { AttendanceEventPublisher } from '../attendance/attendance-events.js';
import { CorrectionsService } from '../attendance/corrections.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { LeaveCoreModule } from '../leave/leave-core.module.js';
import { PayrollGuardModule } from '../payroll/payroll-guard.module.js';

import { RequestEventPublisher } from './request-events.js';
import { RequestsController } from './requests.controller.js';
import { RequestsService } from './requests.service.js';

@Module({
  imports: [AuthModule, LeaveCoreModule, PayrollGuardModule],
  controllers: [RequestsController],
  providers: [RequestsService, CorrectionsService, AttendanceEventPublisher, RequestEventPublisher],
})
export class RequestsModule {}
