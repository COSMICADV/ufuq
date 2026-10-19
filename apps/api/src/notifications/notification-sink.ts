/**
 * The one sink behind every module's event port — DOCUMENT 19
 * "Architecture". Each module publishes through its own port (`*-events.ts`)
 * after its transaction commits; the global notifications module binds every
 * port's token to this class, which hands the events to the pipeline.
 *
 * It stamps each event with a nonce — the identity of a repeatable action —
 * and never throws: the pipeline queues a failure for retry, so the
 * publishing module's committed change is never reported as failed.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';

import type { AttendanceEventSink } from '../attendance/attendance-events.js';
import type { EmployeeEventSink } from '../employees/employee-events.js';
import type { GoalEventSink } from '../goals/goal-events.js';
import type { InventoryEventSink } from '../inventory/inventory-events.js';
import type { LeaveEventSink } from '../leave/leave-events.js';
import type { PayrollEventSink } from '../payroll/payroll-events.js';
import type { ReportEventSink } from '../reports/report-events.js';
import type { RequestEventSink } from '../requests/request-events.js';
import type { TaskEventSink } from '../tasks/task-events.js';

import { NotificationPipeline } from './notification-pipeline.js';
import type { SourceEvent } from './notification-sources.js';

@Injectable()
export class NotificationSink
  implements
    AttendanceEventSink,
    EmployeeEventSink,
    GoalEventSink,
    InventoryEventSink,
    LeaveEventSink,
    PayrollEventSink,
    ReportEventSink,
    RequestEventSink,
    TaskEventSink
{
  constructor(@Inject(NotificationPipeline) private readonly pipeline: NotificationPipeline) {}

  async handle(input: SourceEvent | readonly SourceEvent[]): Promise<void> {
    const events: readonly SourceEvent[] = Array.isArray(input)
      ? (input as readonly SourceEvent[])
      : [input as SourceEvent];
    if (events.length === 0) return;
    // Each publication is its own moment (see `eventKey`).
    await this.pipeline.submit(events.map((event) => ({ ...event, nonce: generateId() })));
  }
}
