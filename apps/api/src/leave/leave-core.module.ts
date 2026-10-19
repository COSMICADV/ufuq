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
 * `LEAVE_EVENT_SINK` is provided by the global notifications module (Phase 15); `LEAVE_PAYROLL_GUARD` is bound to the
 * Phase 11 finalized-payroll check (DOCUMENT 16 rule 12).
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { PayrollGuardModule } from '../payroll/payroll-guard.module.js';

import { LeaveBalancesService } from './leave-balances.service.js';
import { LeaveEventPublisher } from './leave-events.js';
import { FinalizedPayrollLeaveGuard, LEAVE_PAYROLL_GUARD } from './leave-payroll-guard.js';
import { LeaveRequestsService } from './leave-requests.service.js';

@Module({
  imports: [AuthModule, PayrollGuardModule],
  providers: [
    LeaveBalancesService,
    LeaveRequestsService,
    LeaveEventPublisher,
    { provide: LEAVE_PAYROLL_GUARD, useClass: FinalizedPayrollLeaveGuard },
  ],
  exports: [LeaveBalancesService, LeaveRequestsService],
})
export class LeaveCoreModule {}
