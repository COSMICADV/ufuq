/**
 * Phase 8 — performance (DOCUMENT 25 Phase 8, DOCUMENT 14 "Performance").
 *
 * Configuration and on-demand calculation only. The monthly report snapshot
 * that stores a month's scores with the weights in effect is DOCUMENT 18's
 * and Phase 12's.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';

import { PerformanceController } from './performance.controller.js';
import { PerformanceService } from './performance.service.js';

@Module({
  imports: [AuthModule],
  controllers: [PerformanceController],
  providers: [PerformanceService],
})
export class PerformanceModule {}
