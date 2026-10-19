/**
 * Phase 12 — reports (DOCUMENT 25 Phase 12, DOCUMENT 18).
 *
 * Reads every source module and writes only two things of its own: the
 * monthly employee report snapshots and the background export jobs. Nothing
 * from another module is duplicated: performance comes from the performance
 * module's calculation, inventory valuation from the warehouse rules, the
 * movement ledger from the warehouse module's filters.
 *
 * With background jobs on, the `reports` BullMQ queue runs the hourly
 * monthly-snapshot job and the queued exports. Without them (the test suites,
 * a local stack) no worker starts and a queued export runs in this process.
 * `REPORT_EVENT_SINK` is the Phase 15 seam.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { SystemActorService } from '../attendance/system-actor.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { RateLimitService } from '../auth/rate-limit.service.js';

import { MonthlyReportsService } from './monthly-reports.service.js';
import {
  DEFAULT_EXPORT_LIMITS,
  InProcessReportExportQueue,
  REPORT_EXPORT_LIMITS,
  REPORT_EXPORT_QUEUE,
  ReportExportRunner,
  ReportExportService,
} from './report-exports.js';
import {
  DeferredReportEventSink,
  REPORT_EVENT_SINK,
  ReportEventPublisher,
} from './report-events.js';
import { MonthlyReportRunner, ReportJobsScheduler } from './report-jobs.js';
import {
  DEFAULT_REPORT_RATE_LIMIT,
  REPORT_RATE_LIMIT,
  ReportRateLimitGuard,
} from './report-rate-limit.guard.js';
import {
  EmployeeMonthlyReportsController,
  ReportExportsController,
  ReportsController,
} from './reports.controller.js';
import { ReportsService } from './reports.service.js';

export interface ReportsModuleOptions {
  readonly scheduler: boolean;
}

@Module({})
export class ReportsModule {
  static register(options: ReportsModuleOptions): DynamicModule {
    return {
      module: ReportsModule,
      imports: [AuthModule],
      controllers: [ReportsController, ReportExportsController, EmployeeMonthlyReportsController],
      providers: [
        ReportsService,
        ReportExportService,
        ReportExportRunner,
        MonthlyReportsService,
        MonthlyReportRunner,
        SystemActorService,
        RateLimitService,
        ReportRateLimitGuard,
        ReportEventPublisher,
        { provide: REPORT_EVENT_SINK, useClass: DeferredReportEventSink },
        { provide: REPORT_RATE_LIMIT, useValue: DEFAULT_REPORT_RATE_LIMIT },
        { provide: REPORT_EXPORT_LIMITS, useValue: DEFAULT_EXPORT_LIMITS },
        ...(options.scheduler
          ? [
              ReportJobsScheduler,
              { provide: REPORT_EXPORT_QUEUE, useExisting: ReportJobsScheduler },
            ]
          : [
              InProcessReportExportQueue,
              { provide: REPORT_EXPORT_QUEUE, useExisting: InProcessReportExportQueue },
            ]),
      ],
      exports: [MonthlyReportRunner, ReportExportRunner],
    };
  }
}
