/**
 * Task moments as domain events — DOCUMENT 19 `task_assigned`,
 * `task_updated`, `task_deadline_approaching` (employee) and `task_overdue`
 * (admin / manager); DOCUMENT 05 FLOW 09 (🔔 assignee).
 *
 * The tasks module owns the moments; delivery is DOCUMENT 19's pipeline. As
 * in every other module, an event is handed on only **after** its change has
 * committed (DOCUMENT 19 rule 2). The two time-driven moments come from
 * `task-jobs.ts`, which reads DOCUMENT 13 rule 1's own overdue condition.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export type TaskEvent =
  | {
      readonly type: 'task_assigned' | 'task_updated';
      readonly companyId: string;
      readonly taskId: string;
      /** The assignee the event concerns (after a reassignment, the new one). */
      readonly assigneeEmployeeId: string;
      /** Who made the change — never told about their own action. */
      readonly actorUserId: string;
      readonly occurredAt: Date;
    }
  | {
      readonly type: 'task_overdue' | 'task_deadline_approaching';
      readonly companyId: string;
      readonly taskId: string;
      readonly assigneeEmployeeId: string;
      /** `YYYY-MM-DD` — a moved deadline is a new moment, the same one is not. */
      readonly deadline: string;
      readonly occurredAt: Date;
    };

export interface TaskEventSink {
  handle(events: readonly TaskEvent[]): Promise<void>;
}

export const TASK_EVENT_SINK = Symbol('TASK_EVENT_SINK');

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class TaskEventPublisher {
  private readonly logger = new Logger(TaskEventPublisher.name);

  constructor(@Inject(TASK_EVENT_SINK) private readonly sink: TaskEventSink) {}

  async publish(events: readonly TaskEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.sink.handle(events);
    } catch (error) {
      this.logger.error(
        `Task events could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
