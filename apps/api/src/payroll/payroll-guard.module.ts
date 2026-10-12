/**
 * The finalized-payroll guard on its own, so Attendance and Leave can ask it
 * without importing the whole payroll module (which itself builds on them).
 */

import { Module } from '@nestjs/common';

import { PayrollPeriodGuard } from './payroll-period-guard.js';

@Module({
  providers: [PayrollPeriodGuard],
  exports: [PayrollPeriodGuard],
})
export class PayrollGuardModule {}
