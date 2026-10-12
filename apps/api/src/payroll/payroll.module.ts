/**
 * Phase 11 — salary and payroll (DOCUMENT 25 Phase 11, DOCUMENT 15).
 *
 * `AuthModule` supplies `AuditDispatcher` (audit after commit).
 * `PayrollGuardModule` supplies the finalized-period check this module shares
 * with Attendance and Leave. `PAYROLL_EVENT_SINK` is the Phase 15 seam.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.js';

import { EmployeeSalaryService } from './employee-salary.service.js';
import {
  DeferredPayrollEventSink,
  PAYROLL_EVENT_SINK,
  PayrollEventPublisher,
} from './payroll-events.js';
import { PayrollGuardModule } from './payroll-guard.module.js';
import {
  EmployeeSalaryController,
  PayrollController,
  SalaryPoliciesController,
} from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';
import { SalaryPolicyService } from './salary-policy.service.js';

@Module({
  imports: [AuthModule, PayrollGuardModule],
  controllers: [SalaryPoliciesController, EmployeeSalaryController, PayrollController],
  providers: [
    SalaryPolicyService,
    EmployeeSalaryService,
    PayrollService,
    IdempotencyService,
    PayrollEventPublisher,
    { provide: PAYROLL_EVENT_SINK, useClass: DeferredPayrollEventSink },
  ],
  exports: [PayrollService],
})
export class PayrollModule {}
