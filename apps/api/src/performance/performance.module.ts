/**
 * Phase 8 — performance (DOCUMENT 25 Phase 8, DOCUMENT 14 "Performance").
 *
 * Configuration and on-demand calculation. The calculation itself
 * (`performance-month.ts`) is shared with Phase 12's reports and monthly
 * snapshots, which store a month's scores with the weights in effect.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { PerformanceController } from './performance.controller.js';
import { PerformanceService } from './performance.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PerformanceController],
  providers: [PerformanceService],
  exports: [PerformanceService],
})
export class PerformanceModule {}
