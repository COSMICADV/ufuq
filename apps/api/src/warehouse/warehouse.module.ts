/**
 * Phase 13 — warehouse (DOCUMENT 25 Phase 13, DOCUMENT 17).
 *
 * `StockLedgerService` is exported: it is the one writer of the stock ledger,
 * and Phase 14's movement types will be written through it.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { IdempotencyService } from '../common/idempotency.js';

import { StockLedgerService } from './stock-ledger.service.js';
import { StockMovementsController, WarehouseController } from './warehouse.controller.js';
import { WarehouseService } from './warehouse.service.js';

@Module({
  imports: [AuthModule],
  controllers: [WarehouseController, StockMovementsController],
  providers: [WarehouseService, StockLedgerService, IdempotencyService],
  exports: [StockLedgerService],
})
export class WarehouseModule {}
