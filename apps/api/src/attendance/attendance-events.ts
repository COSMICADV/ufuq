/**
 * Attendance moments as domain events — DOCUMENT 19
 * `attendance_correction_submitted` (approver), `correction_approved` /
 * `correction_rejected` (employee), and the nightly job's forgotten
 * check-out: `missing_checkout` (employee) and `employee_missing_checkout`
 * (admin / manager).
 *
 * The attendance module owns the moments — the correction lifecycle and the
 * nightly close (`attendance-generation.service.ts`, DOCUMENT 12's "employee
 * forgets to check out"). Delivery is DOCUMENT 19's pipeline. An event is
 * handed on only **after** its change has committed (DOCUMENT 19 rule 2).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export type AttendanceEvent =
  | {
      readonly type:
        | 'attendance_correction_submitted'
        | 'correction_approved'
        | 'correction_rejected'
        | 'correction_cancelled';
      readonly companyId: string;
      readonly correctionId: string;
      readonly employeeId: string;
      readonly occurredAt: Date;
    }
  | {
      /** The nightly job closed a record that was checked in and never out. */
      readonly type: 'missing_checkout';
      readonly companyId: string;
      readonly attendanceRecordId: string;
      readonly employeeId: string;
      /** `YYYY-MM-DD`, the record's day. */
      readonly date: string;
      readonly occurredAt: Date;
    };

export interface AttendanceEventSink {
  handle(events: readonly AttendanceEvent[]): Promise<void>;
}

export const ATTENDANCE_EVENT_SINK = Symbol('ATTENDANCE_EVENT_SINK');

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class AttendanceEventPublisher {
  private readonly logger = new Logger(AttendanceEventPublisher.name);

  constructor(@Inject(ATTENDANCE_EVENT_SINK) private readonly sink: AttendanceEventSink) {}

  async publish(events: readonly AttendanceEvent[]): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.sink.handle(events);
    } catch (error) {
      this.logger.error(
        `Attendance events could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
