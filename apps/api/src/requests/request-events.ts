/**
 * Request lifecycle as domain events — DOCUMENT 19 `request_submitted`
 * (admin / manager) and `request_reviewed` (employee), "any other request
 * category".
 *
 * Phase 9 owns the moments; **delivery** is DOCUMENT 19's notification
 * pipeline (Phase 15, `notifications/`), which implements
 * {@link RequestEventSink}. Events are handed to it **after the transaction
 * commits** (DOCUMENT 19 rule 2: no notification for a rolled-back
 * transaction). `request_cancelled` notifies nobody: it tells the pipeline
 * that the approvers' notifications no longer describe pending work.
 *
 * Attendance corrections are not published here: their notifications are
 * DOCUMENT 19's `attendance_correction_submitted` / `correction_approved` /
 * `correction_rejected`, which belong to the correction's own logic.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import type { RequestCategoryValue } from './request-rules.js';

export interface RequestEvent {
  readonly type: 'request_submitted' | 'request_reviewed' | 'request_cancelled';
  readonly companyId: string;
  readonly requestId: string;
  readonly category: RequestCategoryValue;
  /** The requester. */
  readonly employeeId: string;
  /** `request_reviewed` only — the decision. */
  readonly decision: 'approved' | 'rejected' | null;
  readonly occurredAt: Date;
}

export interface RequestEventSink {
  handle(event: RequestEvent): Promise<void>;
}

export const REQUEST_EVENT_SINK = Symbol('REQUEST_EVENT_SINK');

/**
 * Hands committed events to the sink. A sink failure is logged and swallowed:
 * the change it describes has already committed, and failing the request now
 * would report a successful change as an error.
 */
@Injectable()
export class RequestEventPublisher {
  private readonly logger = new Logger(RequestEventPublisher.name);

  constructor(@Inject(REQUEST_EVENT_SINK) private readonly sink: RequestEventSink) {}

  async publish(event: RequestEvent): Promise<void> {
    try {
      await this.sink.handle(event);
    } catch (error) {
      this.logger.error(
        `Request event could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
