/**
 * Inventory moments as domain events — DOCUMENT 05 FLOW 18 (🔔 low stock,
 * out of stock), DOCUMENT 17 rules 5, 7, 8 and "Cache and ledger disagree",
 * DOCUMENT 19 (`low_stock`, `out_of_stock`).
 *
 * Phase 14 owns the moments; delivery is DOCUMENT 19's pipeline (Phase 15).
 * As for payroll, leave, goals and requests, an event is handed to the sink
 * only **after the transaction commits** (DOCUMENT 19 rule 2) and after its
 * audit record has been dispatched. The sink is the notification pipeline
 * (`notifications/`); `negative_stock` and `stock_reconciliation_mismatch`
 * are not DOCUMENT 19 notification types and notify nobody.
 *
 *   - `low_stock` / `out_of_stock` fire **once per crossing** (DOCUMENT 19
 *     rule 3): the movement that takes the product's total across the line,
 *     never the ones after it while it stays there.
 *   - `negative_stock` marks a movement that took a location below zero
 *     under the company's setting (rule 5: "always warned and recorded").
 *   - `stock_reconciliation_mismatch` is the reconciliation job's alert.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

export interface InventoryEvent {
  readonly type: 'low_stock' | 'out_of_stock' | 'negative_stock' | 'stock_reconciliation_mismatch';
  readonly companyId: string;
  /** The product concerned; null for a reconciliation run. */
  readonly productId: string | null;
  /** The location, where one is concerned. */
  readonly warehouseId: string | null;
  /** The movement that caused it, where one did. */
  readonly movementId: string | null;
  readonly occurredAt: Date;
}

export interface InventoryEventSink {
  handle(event: InventoryEvent): Promise<void>;
}

export const INVENTORY_EVENT_SINK = Symbol('INVENTORY_EVENT_SINK');

/** Hands committed events on; a sink failure is logged, never reported as the change failing. */
@Injectable()
export class InventoryEventPublisher {
  private readonly logger = new Logger(InventoryEventPublisher.name);

  constructor(@Inject(INVENTORY_EVENT_SINK) private readonly sink: InventoryEventSink) {}

  async publish(events: readonly InventoryEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.sink.handle(event);
      } catch (error) {
        this.logger.error(
          `Inventory event could not be handed on: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
