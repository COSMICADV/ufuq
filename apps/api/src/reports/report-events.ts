/**
 * Report moments as domain events — DOCUMENT 05 FLOW 19 (🔔 "your monthly
 * report is ready"), DOCUMENT 18 "Error states" (an export that fails is a
 * toast **plus a notification**) and "Performance" (a long-running export
 * runs as a background job **with a completion notification**).
 *
 * Phase 12 owns the moments; delivery is DOCUMENT 19's pipeline (Phase 15),
 * which replaces the deferred sink. As in every other module, an event is
 * handed on only **after** its change has committed (DOCUMENT 19 rule 2) and
 * after its audit record has been dispatched. Events carry ids, never
 * figures.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export type ReportEvent =
  | {
      readonly type: 'monthly_report_ready';
      readonly companyId: string;
      readonly employeeId: string;
      readonly reportId: string;
      readonly year: number;
      readonly month: number;
      readonly occurredAt: Date;
    }
  | {
      readonly type: 'report_export_completed' | 'report_export_failed';
      readonly companyId: string;
      /** The user who asked for the export — the notification's recipient. */
      readonly userId: string;
      readonly exportId: string;
      readonly reportKey: string;
      readonly occurredAt: Date;
    };

export interface ReportEventSink {
  handle(event: ReportEvent): Promise<void>;
}

export const REPORT_EVENT_SINK = Symbol('REPORT_EVENT_SINK');

@Injectable()
export class DeferredReportEventSink implements ReportEventSink {
  private readonly logger = new Logger('ReportEvents');

  handle(event: ReportEvent): Promise<void> {
    this.logger.debug(`${event.type} — notification delivery is Phase 15.`);
    return Promise.resolve();
  }
}

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class ReportEventPublisher {
  private readonly logger = new Logger(ReportEventPublisher.name);

  constructor(@Inject(REPORT_EVENT_SINK) private readonly sink: ReportEventSink) {}

  async publish(events: readonly ReportEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.sink.handle(event);
      } catch (error) {
        this.logger.error(
          `Report event could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
