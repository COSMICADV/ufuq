/**
 * Inventory endpoints — DOCUMENT 08 §4.11, DOCUMENT 17 "API requirements".
 *
 * | Method | Path                          | Permission                                        |
 * | ------ | ----------------------------- | ------------------------------------------------- |
 * | GET    | `/products`                   | product.view                                      |
 * | POST   | `/products`                   | product.create (+ stock.movement_create for initial stock) |
 * | GET    | `/products/{id}`              | product.view                                      |
 * | PATCH  | `/products/{id}`              | product.update                                    |
 * | GET    | `/products/{id}/stock`        | stock.view · per location                         |
 * | GET    | `/products/{id}/movements`    | stock.view                                        |
 * | GET    | `/product-categories`         | product.view                                      |
 * | POST   | `/product-categories`         | product.create                                    |
 * | GET    | `/suppliers`                  | product.view                                      |
 * | POST   | `/suppliers`                  | product.create                                    |
 * | GET    | `/suppliers/{id}`             | product.view — added in Phase 14                  |
 * | PATCH  | `/suppliers/{id}`             | product.update — added in Phase 14                |
 * | POST   | `/stock-movements`            | stock.movement_create · Idempotency-Key required  |
 * | GET    | `/stock-movements/{id}`       | stock.view — added in Phase 14                    |
 * | GET    | `/inventory/alerts`           | stock.view · low and out of stock                 |
 * | POST   | `/inventory/reconciliation`   | stock.movement_create — added in Phase 14         |
 *
 * `GET /stock-movements` (the filtered ledger) stays in the warehouse module.
 * All ADMIN-only in V1. **There is no `PATCH /products/{id}/quantity`** and no
 * endpoint that edits or deletes a movement.
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
import { IsIn, IsOptional, IsUUID } from 'class-validator';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { idempotencyRequest } from '../common/idempotency.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { PaginationQueryDto, resolvePage } from '../company-structure/dto/pagination.dto.js';
import type { MovementPayload } from '../warehouse/warehouse.service.js';

import type { CategoryPayload, SupplierPayload } from './catalogue.service.js';
import { CatalogueService } from './catalogue.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreateCategoryDto,
  CreateMovementDto,
  CreateProductDto,
  CreateSupplierDto,
  ListProductsQueryDto,
  ListSuppliersQueryDto,
  RunReconciliationDto,
  UpdateProductDto,
  UpdateSupplierDto,
} from './dto/inventory.dto.js';
import { ProductsService } from './products.service.js';
import type {
  AlertPayload,
  ProductDetailPayload,
  ProductPayload,
  ProductStockPayload,
} from './products.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import type { ReconciliationReport } from './reconciliation.service.js';
import { StockMovementService } from './stock-movements.service.js';
import type { CreatedMovementPayload } from './stock-movements.service.js';

const uuidParam = new ParseUUIDPipe();
const ALERT_TYPES = ['low_stock', 'out_of_stock'] as const;

export class ProductMovementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'invalid' })
  warehouse_id?: string;
}

export class AlertsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(ALERT_TYPES, { message: 'invalid' })
  type?: (typeof ALERT_TYPES)[number];
}

@Controller('products')
export class ProductsController {
  constructor(@Inject(ProductsService) private readonly products: ProductsService) {}

  @Get()
  @RequirePermission('product.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListProductsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<ProductPayload>> {
    const { items, total } = await this.products.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('product.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateProductDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ProductDetailPayload>> {
    return single(await this.products.create(ctx, dto, origin), { locale });
  }

  @Get(':id')
  @RequirePermission('product.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ProductDetailPayload>> {
    return single(await this.products.get(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('product.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateProductDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ProductDetailPayload>> {
    return single(await this.products.update(ctx, id, dto, origin), { locale });
  }

  @Get(':id/stock')
  @RequirePermission('stock.view')
  async stock(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<readonly ProductStockPayload[]>> {
    return single(await this.products.stock(ctx, id), { locale });
  }

  @Get(':id/movements')
  @RequirePermission('stock.view')
  async movements(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: ProductMovementsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<MovementPayload>> {
    const { items, total } = await this.products.movementHistory(ctx, id, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}

@Controller('product-categories')
export class CategoriesController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  @RequirePermission('product.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<CategoryPayload>> {
    const { items, total } = await this.catalogue.listCategories(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('product.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateCategoryDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CategoryPayload>> {
    return single(await this.catalogue.createCategory(ctx, dto, origin), { locale });
  }
}

@Controller('suppliers')
export class SuppliersController {
  constructor(@Inject(CatalogueService) private readonly catalogue: CatalogueService) {}

  @Get()
  @RequirePermission('product.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListSuppliersQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<SupplierPayload>> {
    const { items, total } = await this.catalogue.listSuppliers(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('product.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateSupplierDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<SupplierPayload>> {
    return single(await this.catalogue.createSupplier(ctx, dto, origin), { locale });
  }

  @Get(':id')
  @RequirePermission('product.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<SupplierPayload>> {
    return single(await this.catalogue.getSupplier(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('product.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateSupplierDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<SupplierPayload>> {
    return single(await this.catalogue.updateSupplier(ctx, id, dto, origin), { locale });
  }
}

@Controller('stock-movements')
export class MovementsController {
  constructor(@Inject(StockMovementService) private readonly movements: StockMovementService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('stock.movement_create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateMovementDto,
    @Headers('idempotency-key') key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CreatedMovementPayload>> {
    const idempotency = idempotencyRequest(key, 'stock.movement', dto);
    return single(await this.movements.create(ctx, dto, idempotency, origin), { locale });
  }

  @Get(':id')
  @RequirePermission('stock.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CreatedMovementPayload>> {
    return single(await this.movements.get(ctx, id), { locale });
  }
}

@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(ProductsService) private readonly products: ProductsService,
    @Inject(ReconciliationService) private readonly reconciliation: ReconciliationService,
  ) {}

  @Get('alerts')
  @RequirePermission('stock.view')
  async alerts(
    @CurrentUser() ctx: AuthContext,
    @Query() query: AlertsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<AlertPayload>> {
    const { items, total } = await this.products.alerts(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post('reconciliation')
  @HttpCode(200)
  @RequirePermission('stock.movement_create')
  async reconcile(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: RunReconciliationDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReconciliationReport>> {
    return single(await this.reconciliation.runForAdmin(ctx, dto.rebuild === true, origin), {
      locale,
    });
  }
}
