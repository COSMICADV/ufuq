/**
 * Payroll moments as domain events — DOCUMENT 05 FLOWs 14–16 (🔔 marks),
 * DOCUMENT 19.
 *
 * Phase 11 owns the moments; delivery is DOCUMENT 19's pipeline (Phase 15).
 * As for leave, goals and requests, an event is handed to the sink only
 * **after the transaction commits** (DOCUMENT 19 rule 2) and after its audit
 * record has been dispatched. The deferred sink records only that delivery is
 * pending. Events carry identifiers, never amounts: a notification payload is
 * no place for a salary (DOCUMENT 20 §8).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export interface PayrollEvent {
  readonly type:
    | 'payroll_generated'
    | 'payroll_finalized'
    | 'payroll_marked_paid'
    | 'payroll_adjustment_created'
    | 'payroll_deduction_added'
    | 'payroll_bonus_added';
  readonly companyId: string;
  readonly periodId: string;
  /** The affected employee, for line-level events. */
  readonly employeeId: string | null;
  readonly occurredAt: Date;
}

export interface PayrollEventSink {
  handle(event: PayrollEvent): Promise<void>;
}

export const PAYROLL_EVENT_SINK = Symbol('PAYROLL_EVENT_SINK');

@Injectable()
export class DeferredPayrollEventSink implements PayrollEventSink {
  private readonly logger = new Logger('PayrollEvents');

  handle(event: PayrollEvent): Promise<void> {
    this.logger.debug(
      `${event.type} for period ${event.periodId} — notification delivery is Phase 15.`,
    );
    return Promise.resolve();
  }
}

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class PayrollEventPublisher {
  private readonly logger = new Logger(PayrollEventPublisher.name);

  constructor(@Inject(PAYROLL_EVENT_SINK) private readonly sink: PayrollEventSink) {}

  async publish(event: PayrollEvent): Promise<void> {
    try {
      await this.sink.handle(event);
    } catch (error) {
      this.logger.error(
        `Payroll event could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
