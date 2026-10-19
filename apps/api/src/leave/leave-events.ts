/**
 * Leave lifecycle as domain events — DOCUMENT 19 `leave_request_submitted`
 * (approver) and `leave_approved` / `leave_rejected` (employee), plus the
 * cancellation.
 *
 * Phase 10 owns the moments; delivery is DOCUMENT 19's pipeline (Phase 15).
 * As for goals and requests, events are handed to a sink **after the
 * transaction commits** (DOCUMENT 19 rule 2). The sink is the notification
 * pipeline (`notifications/`). `leave_cancelled` notifies nobody: it marks
 * the approvers' notifications handled.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export interface LeaveEvent {
  readonly type:
    | 'leave_request_submitted'
    | 'leave_approved'
    | 'leave_rejected'
    | 'leave_cancelled';
  readonly companyId: string;
  readonly leaveRequestId: string;
  readonly employeeId: string;
  readonly occurredAt: Date;
}

export interface LeaveEventSink {
  handle(event: LeaveEvent): Promise<void>;
}

export const LEAVE_EVENT_SINK = Symbol('LEAVE_EVENT_SINK');

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class LeaveEventPublisher {
  private readonly logger = new Logger(LeaveEventPublisher.name);

  constructor(@Inject(LEAVE_EVENT_SINK) private readonly sink: LeaveEventSink) {}

  async publish(event: LeaveEvent): Promise<void> {
    try {
      await this.sink.handle(event);
    } catch (error) {
      this.logger.error(
        `Leave event could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
