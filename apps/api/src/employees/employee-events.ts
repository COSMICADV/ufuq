/**
 * Employee moments as domain events — DOCUMENT 19 `tasks_need_reassignment`
 * ("Employee deactivated with open tasks", admin / manager).
 *
 * The employees module owns the moment: a deactivation that commits while the
 * employee still holds open tasks. The open-task count is DOCUMENT 13's own
 * "open" (not completed, not cancelled, not deleted), read in the same
 * transaction. Delivery is DOCUMENT 19's pipeline, after commit.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export interface EmployeeEvent {
  readonly type: 'tasks_need_reassignment';
  readonly companyId: string;
  readonly employeeId: string;
  readonly openTasks: number;
  /** The administrator who deactivated the employee. */
  readonly actorUserId: string;
  readonly occurredAt: Date;
}

export interface EmployeeEventSink {
  handle(events: readonly EmployeeEvent[]): Promise<void>;
}

export const EMPLOYEE_EVENT_SINK = Symbol('EMPLOYEE_EVENT_SINK');

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class EmployeeEventPublisher {
  private readonly logger = new Logger(EmployeeEventPublisher.name);

  constructor(@Inject(EMPLOYEE_EVENT_SINK) private readonly sink: EmployeeEventSink) {}

  async publish(events: readonly EmployeeEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.sink.handle(events);
    } catch (error) {
      this.logger.error(
        `Employee events could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
