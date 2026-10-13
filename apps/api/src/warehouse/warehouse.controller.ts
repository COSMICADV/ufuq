/**
 * Warehouse endpoints — DOCUMENT 08 §4.11 (Phase 13 part), DOCUMENT 17.
 *
 * | Method | Endpoint                          | Permission                         |
 * | ------ | --------------------------------- | ---------------------------------- |
 * | GET    | `/warehouses`                     | warehouse.view                     |
 * | POST   | `/warehouses`                     | warehouse.manage                   |
 * | GET    | `/warehouses/dashboard`           | warehouse.view                     |
 * | GET    | `/warehouses/transfers`           | stock.view (added in Phase 13)     |
 * | POST   | `/warehouses/transfers`           | stock.transfer · Idempotency-Key   |
 * | GET    | `/warehouses/transfers/{groupId}` | stock.view (added in Phase 13)     |
 * | GET    | `/warehouses/{id}`                | warehouse.view                     |
 * | PATCH  | `/warehouses/{id}`                | warehouse.manage                   |
 * | GET    | `/warehouses/{id}/stock`          | stock.view                         |
 * | GET    | `/stock-movements`                | stock.view (read only; POST is Phase 14) |
 *
 * All ADMIN-only in V1. There is no endpoint that sets a quantity (DOCUMENT
 * 17 rule 1, DOCUMENT 08 §4.11). Literal paths are declared before `:id`.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { idempotencyRequest } from '../common/idempotency.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime.
import { PaginationQueryDto, resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreateTransferDto,
  CreateWarehouseDto,
  ListMovementsQueryDto,
  ListWarehousesQueryDto,
  UpdateWarehouseDto,
} from './dto/warehouse.dto.js';
import { WarehouseService } from './warehouse.service.js';
import type {
  MovementPayload,
  StockRowPayload,
  TransferPayload,
  WarehouseDashboard,
  WarehousePayload,
} from './warehouse.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('warehouses')
export class WarehouseController {
  constructor(@Inject(WarehouseService) private readonly warehouses: WarehouseService) {}

  @Get()
  @RequirePermission('warehouse.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListWarehousesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<WarehousePayload>> {
    const { items, total } = await this.warehouses.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('warehouse.manage')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateWarehouseDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WarehousePayload>> {
    return single(await this.warehouses.create(ctx, dto, origin), { locale });
  }

  @Get('dashboard')
  @RequirePermission('warehouse.view')
  async dashboard(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WarehouseDashboard>> {
    return single(await this.warehouses.dashboard(ctx), { locale });
  }

  @Get('transfers')
  @RequirePermission('stock.view')
  async listTransfers(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<TransferPayload>> {
    const { items, total } = await this.warehouses.listTransfers(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post('transfers')
  @HttpCode(201)
  @RequirePermission('stock.transfer')
  async transfer(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateTransferDto,
    @Headers('idempotency-key') key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TransferPayload>> {
    const idempotency = idempotencyRequest(key, 'stock.transfer', dto);
    return single(await this.warehouses.transfer(ctx, dto, idempotency, origin), { locale });
  }

  @Get('transfers/:groupId')
  @RequirePermission('stock.view')
  async getTransfer(
    @CurrentUser() ctx: AuthContext,
    @Param('groupId', uuidParam) groupId: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TransferPayload>> {
    return single(await this.warehouses.getTransfer(ctx, groupId), { locale });
  }

  @Get(':id')
  @RequirePermission('warehouse.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WarehousePayload>> {
    return single(await this.warehouses.get(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('warehouse.manage')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateWarehouseDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WarehousePayload>> {
    return single(await this.warehouses.update(ctx, id, dto, origin), { locale });
  }

  @Get(':id/stock')
  @RequirePermission('stock.view')
  async stock(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<StockRowPayload>> {
    const { items, total } = await this.warehouses.stock(ctx, id, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}

@Controller('stock-movements')
export class StockMovementsController {
  constructor(@Inject(WarehouseService) private readonly warehouses: WarehouseService) {}

  @Get()
  @RequirePermission('stock.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListMovementsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<MovementPayload>> {
    const { items, total } = await this.warehouses.movements(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}
