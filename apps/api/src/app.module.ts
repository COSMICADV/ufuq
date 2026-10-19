import { Module } from '@nestjs/common';
import { PublicSiteModule } from './public-site/public.module.js';
import type { DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '@ufuq/config';

import { APP_ENV, APP_INFO } from './app.tokens.js';
import type { AppInfo } from './app.tokens.js';
import { AttendanceModule } from './attendance/attendance.module.js';
import { AttachmentsModule } from './attachments/attachments.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuditRetryWorker } from './auth/audit-dispatcher.js';
import { AuthModule } from './auth/auth.module.js';
import { CompanyStructureModule } from './company-structure/company-structure.module.js';
import { CsrfGuard } from './auth/guards/csrf.guard.js';
import { PermissionsGuard } from './auth/guards/permissions.guard.js';
import { SessionAuthGuard } from './auth/guards/session-auth.guard.js';
import { DbModule } from './common/db.module.js';
import { RedisModule } from './common/redis.module.js';
import { EmployeesModule } from './employees/employees.module.js';
import { GoalsModule } from './goals/goals.module.js';
import { HealthModule } from './health/health.module.js';
import { MailModule } from './mail/mail.module.js';
import { PerformanceModule } from './performance/performance.module.js';
import { LeaveModule } from './leave/leave.module.js';
import { PayrollModule } from './payroll/payroll.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { WarehouseModule } from './warehouse/warehouse.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RequestsModule } from './requests/requests.module.js';
import { TasksModule } from './tasks/tasks.module.js';

/**
 * The application root.
 *
 * Modular monolith: one process, one deployable, feature modules that own their
 * own boundary. Phase 3 added authentication and the two infrastructure
 * connections it needs (`DbModule`, `RedisModule`); Phase 4 adds company
 * structure; Phase 5 adds employees and the SMTP connection its invitation
 * email needs (`MailModule`); Phase 6 adds attendance and, with it, the first
 * background worker (`AttendanceModule`, BullMQ on the existing Redis); Phase 7
 * adds tasks (`TasksModule`) and, as an approved addendum, the generic
 * attachment store over private S3-compatible storage (`AttachmentsModule`,
 * AD-02); Phase 8 adds goals (`GoalsModule`, with its period-end job) and the
 * configurable performance model (`PerformanceModule`); Phase 9 adds the
 * unified Requests Centre (`RequestsModule`); Phase 10 adds leave
 * (`LeaveModule`, with its carry-over job); Phase 11 adds salary and payroll
 * (`PayrollModule`); Phase 13 adds warehouses and transfers
 * (`WarehouseModule`); Phase 14 the inventory on top of it
 * (`InventoryModule`); Phase 12, executed after them, the reports that read
 * every module (`ReportsModule`, with the monthly snapshot job); Phase 15 the
 * notifications every module's events feed (`NotificationsModule`, global).
 * The remaining modules arrive one phase at a time (DOCUMENT 25).
 *
 * The three global guards run in this order for every request:
 *  1. `SessionAuthGuard` — DOCUMENT 09 §4 check 1, and binds tenant scope.
 *  2. `CsrfGuard` — DOCUMENT 20 §6, reads the `authContext` guard 1 set.
 *  3. `PermissionsGuard` — DOCUMENT 09 §4 check 3.
 * Order matters: 2 and 3 both depend on state 1 attaches to the request.
 *
 * The environment is passed in rather than read here, so a test can construct
 * the application without touching `process.env`.
 */
/**
 * Whether this process runs background work. A test suite boots the
 * application for its endpoints and must not also start a BullMQ worker
 * against the test's Redis, so it says so explicitly.
 */
export interface AppModuleOptions {
  readonly backgroundJobs: boolean;
}

@Module({})
export class AppModule {
  static register(
    env: Env,
    info: AppInfo,
    options: AppModuleOptions = { backgroundJobs: true },
  ): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DbModule.register(env),
        RedisModule.register(env),
        MailModule.register(env),
        HealthModule,
        PublicSiteModule,
        AuthModule,
        CompanyStructureModule,
        EmployeesModule,
        AttendanceModule.register({ scheduler: options.backgroundJobs }),
        AuditModule,
        AttachmentsModule.register(env),
        TasksModule.register({ scheduler: options.backgroundJobs }),
        GoalsModule.register({ scheduler: options.backgroundJobs }),
        PerformanceModule,
        RequestsModule,
        LeaveModule.register(env, { scheduler: options.backgroundJobs }),
        PayrollModule,
        WarehouseModule,
        InventoryModule.register({ scheduler: options.backgroundJobs }),
        ReportsModule.register({ scheduler: options.backgroundJobs }),
        NotificationsModule.register({ scheduler: options.backgroundJobs }),
      ],
      providers: [
        { provide: APP_ENV, useValue: env },
        { provide: APP_INFO, useValue: info },
        { provide: APP_GUARD, useClass: SessionAuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        // Retries post-commit audit writes that failed (DOCUMENT 21 §2).
        ...(options.backgroundJobs ? [AuditRetryWorker] : []),
      ],
      exports: [APP_ENV, APP_INFO],
    };
  }
}
