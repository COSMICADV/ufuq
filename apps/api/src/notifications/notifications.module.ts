/**
 * Phase 15 — notifications (DOCUMENT 25 Phase 15, DOCUMENT 19).
 *
 * Global, because it is the sink behind every module's event port: each
 * port's token (`GOAL_EVENT_SINK`, `LEAVE_EVENT_SINK`, …) is bound here to
 * {@link NotificationSink}, and each module keeps only its own publisher.
 * Nothing that publishes a moment knows who is told.
 *
 * V1 dispatches through one channel, `in_app` (DOCUMENT 19 "Channels").
 * Email and push are future dispatchers: a class implementing
 * `NotificationChannelDispatcher`, added to `NOTIFICATION_CHANNELS`.
 *
 * Background work — the retry worker and the retention job — is registered
 * only when background jobs are, as for every other module.
 */

import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { ATTENDANCE_EVENT_SINK } from '../attendance/attendance-events.js';
import { AuthModule } from '../auth/auth.module.js';
import { EMPLOYEE_EVENT_SINK } from '../employees/employee-events.js';
import { GOAL_EVENT_SINK } from '../goals/goal-events.js';
import { INVENTORY_EVENT_SINK } from '../inventory/inventory-events.js';
import { LEAVE_EVENT_SINK } from '../leave/leave-events.js';
import { PAYROLL_EVENT_SINK } from '../payroll/payroll-events.js';
import { REPORT_EVENT_SINK } from '../reports/report-events.js';
import { REQUEST_EVENT_SINK } from '../requests/request-events.js';
import { TASK_EVENT_SINK } from '../tasks/task-events.js';

import { InAppChannel, NOTIFICATION_CHANNELS } from './notification-channels.js';
import {
  BullMqNotificationRetryQueue,
  NOTIFICATION_RETRY_QUEUE,
  NotificationPipeline,
  NotificationRetryWorker,
} from './notification-pipeline.js';
import { NotificationRetention, NotificationRetentionScheduler } from './notification-retention.js';
import { NotificationRules } from './notification-rules.js';
import { NotificationSettingsService } from './notification-settings.service.js';
import { NotificationSink } from './notification-sink.js';
import {
  NotificationSettingsController,
  NotificationsController,
} from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { RecipientResolver } from './recipients.js';

export interface NotificationsModuleOptions {
  readonly scheduler: boolean;
}

const SINK_TOKENS = [
  ATTENDANCE_EVENT_SINK,
  EMPLOYEE_EVENT_SINK,
  GOAL_EVENT_SINK,
  INVENTORY_EVENT_SINK,
  LEAVE_EVENT_SINK,
  PAYROLL_EVENT_SINK,
  REPORT_EVENT_SINK,
  REQUEST_EVENT_SINK,
  TASK_EVENT_SINK,
] as const;

@Global()
@Module({})
export class NotificationsModule {
  static register(options: NotificationsModuleOptions): DynamicModule {
    return {
      module: NotificationsModule,
      imports: [AuthModule],
      controllers: [NotificationsController, NotificationSettingsController],
      providers: [
        RecipientResolver,
        NotificationRules,
        InAppChannel,
        {
          provide: NOTIFICATION_CHANNELS,
          useFactory: (inApp: InAppChannel) => [inApp],
          inject: [InAppChannel],
        },
        { provide: NOTIFICATION_RETRY_QUEUE, useClass: BullMqNotificationRetryQueue },
        NotificationPipeline,
        NotificationSink,
        ...SINK_TOKENS.map((token) => ({ provide: token, useExisting: NotificationSink })),
        NotificationsService,
        NotificationSettingsService,
        NotificationRetention,
        ...(options.scheduler ? [NotificationRetryWorker, NotificationRetentionScheduler] : []),
      ],
      exports: [...SINK_TOKENS, NotificationPipeline, NotificationRetention],
    };
  }
}
