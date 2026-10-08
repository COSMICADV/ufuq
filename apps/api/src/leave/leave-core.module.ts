/**
 * The part of leave that other modules use — the request and balance services
 * with their ports (Phase 10).
 *
 * Separate from `LeaveModule` because `RequestsModule` delegates a leave
 * row's decisions to `LeaveRequestsService` (OD-09), and the endpoints, the
 * carry-over job and its scheduler have no business being instantiated a
 * second time inside the requests module. `AttachmentsService` comes from the
 * global attachments module.
 *
 * `LEAVE_EVENT_SINK` is the Phase 15 seam; `LEAVE_PAYROLL_GUARD` is the Phase
 * 11 seam (finalized payroll periods, DOCUMENT 16 rule 12).
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { LeaveBalancesService } from './leave-balances.service.js';
import { DeferredLeaveEventSink, LEAVE_EVENT_SINK, LeaveEventPublisher } from './leave-events.js';
import { LEAVE_PAYROLL_GUARD, NoPayrollPeriodsGuard } from './leave-payroll-guard.js';
import { LeaveRequestsService } from './leave-requests.service.js';

@Module({
  imports: [AuthModule],
  providers: [
    LeaveBalancesService,
    LeaveRequestsService,
    LeaveEventPublisher,
    { provide: LEAVE_EVENT_SINK, useClass: DeferredLeaveEventSink },
    { provide: LEAVE_PAYROLL_GUARD, useClass: NoPayrollPeriodsGuard },
  ],
  exports: [LeaveBalancesService, LeaveRequestsService],
})
export class LeaveCoreModule {}
