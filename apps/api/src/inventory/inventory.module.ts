/**
 * Phase 14 — inventory (DOCUMENT 25 Phase 14, DOCUMENT 17).
 *
 * Built on Phase 13's warehouse module: the ledger (`StockLedgerService`) is
 * imported, never duplicated. `INVENTORY_EVENT_SINK` is the Phase 15 seam:
 * notifications replace the deferred sink here, and nothing that detects a
 * crossing changes. The daily reconciliation job is registered only when
 * background jobs are, exactly as for attendance, goals and leave.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';

import { SystemActorService } from '../attendance/system-actor.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.js';
import { WarehouseModule } from '../warehouse/warehouse.module.js';

import { CatalogueService } from './catalogue.service.js';
import {
  CategoriesController,
  InventoryController,
  MovementsController,
  ProductsController,
  SuppliersController,
} from './inventory.controller.js';
import {
  DeferredInventoryEventSink,
  INVENTORY_EVENT_SINK,
  InventoryEventPublisher,
} from './inventory-events.js';
import { ProductsService } from './products.service.js';
import { ReconciliationRunner, ReconciliationScheduler } from './reconciliation-jobs.js';
import { ReconciliationService } from './reconciliation.service.js';
import { StockMovementService } from './stock-movements.service.js';

export interface InventoryModuleOptions {
  readonly scheduler: boolean;
}

@Module({})
export class InventoryModule {
  static register(options: InventoryModuleOptions): DynamicModule {
    return {
      module: InventoryModule,
      imports: [AuthModule, WarehouseModule],
      controllers: [
        ProductsController,
        CategoriesController,
        SuppliersController,
        MovementsController,
        InventoryController,
      ],
      providers: [
        ProductsService,
        CatalogueService,
        StockMovementService,
        ReconciliationService,
        ReconciliationRunner,
        SystemActorService,
        IdempotencyService,
        InventoryEventPublisher,
        { provide: INVENTORY_EVENT_SINK, useClass: DeferredInventoryEventSink },
        ...(options.scheduler ? [ReconciliationScheduler] : []),
      ],
      exports: [ReconciliationService, ReconciliationRunner],
    };
  }
}
