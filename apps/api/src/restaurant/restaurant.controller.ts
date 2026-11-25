import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Locale } from '@ufuq/i18n';
import type { Request, Response } from 'express';

import { UploadTooLargeFilter } from '../attachments/upload-too-large.filter.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  BranchQueryDto,
  CancelDto,
  CategoryDto,
  CreateBranchDto,
  CreateItemDto,
  CreateOrderDto,
  CreateTableDto,
  ImageQueryDto,
  MenuQueryDto,
  OrdersQueryDto,
  StatusDto,
  UpdateBranchDto,
  UpdateCategoryDto,
  UpdateItemDto,
  UpdateStaffDto,
  UpdateTableDto,
  WaiterDto,
} from './restaurant.dto.js';
import { RestaurantEvents } from './restaurant-events.js';
import type { OrderEvent } from './restaurant-events.js';
import { RestaurantMenuService } from './menu.service.js';
import type { MenuItemPayload, MenuPayload, UploadedPart } from './menu.service.js';
import { RestaurantOrdersService } from './orders.service.js';
import type { OrderPayload } from './orders.service.js';
import { RestaurantSetupService } from './setup.service.js';
import type {
  BranchPayload,
  PersonRef,
  RestaurantMePayload,
  StaffPayload,
  TablePayload,
} from './setup.service.js';

const uuid = new ParseUUIDPipe();

/** How often an idle stream sends a heartbeat, and how long one stays open before the screen reconnects. */
const HEARTBEAT_MS = 20_000;
const STREAM_LIFETIME_MS = 30 * 60_000;

/**
 * 1to1OS Business — Restaurants & Cafés. No company role permission gates
 * these routes: every service method resolves the caller's restaurant access
 * (owner, or one role in one branch) and a company that is not a restaurant
 * answers 404.
 */
@Controller('restaurant')
export class RestaurantController {
  constructor(
    @Inject(RestaurantSetupService) private readonly setup: RestaurantSetupService,
    @Inject(RestaurantMenuService) private readonly menu: RestaurantMenuService,
    @Inject(RestaurantOrdersService) private readonly orders: RestaurantOrdersService,
    @Inject(RestaurantEvents) private readonly events: RestaurantEvents,
  ) {}

  @Get('me')
  async me(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RestaurantMePayload>> {
    return single(await this.setup.me(ctx), { locale });
  }

  // --- Branches -------------------------------------------------------------

  @Get('branches')
  async branches(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BranchPayload[]>> {
    return single(await this.setup.branches(ctx), { locale });
  }

  @Post('branches')
  async createBranch(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateBranchDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BranchPayload[]>> {
    return single(await this.setup.createBranch(ctx, dto, origin), { locale });
  }

  @Patch('branches/:id')
  async updateBranch(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateBranchDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BranchPayload[]>> {
    return single(await this.setup.updateBranch(ctx, id, dto, origin), { locale });
  }

  // --- Team -----------------------------------------------------------------

  @Get('staff')
  async staff(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<StaffPayload[]>> {
    return single(await this.setup.staff(ctx), { locale });
  }

  @Put('staff/:employeeId')
  async updateStaff(
    @CurrentUser() ctx: AuthContext,
    @Param('employeeId', uuid) employeeId: string,
    @Body() dto: UpdateStaffDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<StaffPayload[]>> {
    return single(await this.setup.updateStaff(ctx, employeeId, dto, origin), { locale });
  }

  @Delete('staff/:employeeId')
  async removeStaff(
    @CurrentUser() ctx: AuthContext,
    @Param('employeeId', uuid) employeeId: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<StaffPayload[]>> {
    return single(await this.setup.removeStaff(ctx, employeeId, origin), { locale });
  }

  @Get('waiters')
  async waiters(
    @CurrentUser() ctx: AuthContext,
    @Query() query: BranchQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PersonRef[]>> {
    return single(await this.setup.waiters(ctx, query.branch_id), { locale });
  }

  // --- Tables ---------------------------------------------------------------

  @Get('tables')
  async tables(
    @CurrentUser() ctx: AuthContext,
    @Query() query: BranchQueryDto & { archived?: string },
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TablePayload[]>> {
    return single(await this.setup.tables(ctx, query.branch_id, query.archived === 'true'), {
      locale,
    });
  }

  @Post('tables')
  async createTable(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateTableDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TablePayload[]>> {
    return single(await this.setup.createTable(ctx, dto, origin), { locale });
  }

  @Patch('tables/:id')
  async updateTable(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateTableDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TablePayload[]>> {
    return single(await this.setup.updateTable(ctx, id, dto, origin), { locale });
  }

  // --- Menu -----------------------------------------------------------------

  @Get('menu')
  async getMenu(
    @CurrentUser() ctx: AuthContext,
    @Query() query: MenuQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuPayload>> {
    return single(await this.menu.menu(ctx, query.archived === 'true'), { locale });
  }

  @Post('menu/categories')
  async createCategory(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CategoryDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuPayload>> {
    return single(await this.menu.createCategory(ctx, dto, origin), { locale });
  }

  @Patch('menu/categories/:id')
  async updateCategory(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCategoryDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuPayload>> {
    return single(await this.menu.updateCategory(ctx, id, dto, origin), { locale });
  }

  @Post('menu/items')
  async createItem(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateItemDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuItemPayload>> {
    return single(await this.menu.createItem(ctx, dto, origin), { locale });
  }

  @Patch('menu/items/:id')
  async updateItem(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateItemDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuItemPayload>> {
    return single(await this.menu.updateItem(ctx, id, dto, origin), { locale });
  }

  @Post('menu/items/:id/image')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('image'))
  @UseFilters(UploadTooLargeFilter)
  async uploadImage(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @UploadedFile() file: UploadedPart | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuItemPayload>> {
    return single(await this.menu.uploadImage(ctx, id, file, origin), { locale });
  }

  @Delete('menu/items/:id/image')
  async removeImage(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MenuItemPayload>> {
    return single(await this.menu.removeImage(ctx, id, origin), { locale });
  }

  @Get('menu/items/:id/image')
  async image(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Query() _query: ImageQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.menu.image(ctx, id);
    response.set({
      'Content-Type': file.contentType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // The URL carries the photo's version, so a cached copy is never stale.
      'Cache-Control': 'private, max-age=604800, immutable',
    });
    return new StreamableFile(file.stream);
  }

  // --- Orders ---------------------------------------------------------------

  @Post('orders')
  async createOrder(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateOrderDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload>> {
    return single(await this.orders.create(ctx, dto, origin), { locale });
  }

  @Get('orders')
  async listOrders(
    @CurrentUser() ctx: AuthContext,
    @Query() query: OrdersQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload[]>> {
    return single(await this.orders.list(ctx, query), { locale });
  }

  @Get('orders/:id')
  async getOrder(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload>> {
    return single(await this.orders.get(ctx, id), { locale });
  }

  @Post('orders/:id/status')
  @HttpCode(200)
  async setStatus(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: StatusDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload>> {
    return single(await this.orders.setStatus(ctx, id, dto.status, origin), { locale });
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CancelDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload>> {
    return single(await this.orders.cancel(ctx, id, dto.reason, origin), { locale });
  }

  @Patch('orders/:id/waiter')
  async setWaiter(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: WaiterDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<OrderPayload>> {
    return single(await this.orders.setWaiter(ctx, id, dto.waiter_id, origin), { locale });
  }

  /**
   * GET /restaurant/stream — Server-Sent Events for one branch. Access and
   * branch are decided when the stream opens; each event names an order and
   * its status, and the screen asks the API for the rest.
   */
  @Get('stream')
  async stream(
    @CurrentUser() ctx: AuthContext,
    @Query() query: BranchQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const scope = await this.orders.streamScope(ctx, query.branch_id);
    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells proxies not to buffer the stream.
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    const write = (text: string): void => {
      try {
        response.write(text);
      } catch (error) {
        this.orders.logStreamError(error);
      }
    };
    write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ branch_id: scope.branchId })}\n\n`);

    const unsubscribe = this.events.subscribe(ctx.companyId, (event: OrderEvent) => {
      if (event.branch_id !== scope.branchId || !this.orders.hears(scope.access, event)) return;
      write(`event: order\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      write(`: ping\n\n`);
    }, HEARTBEAT_MS);
    // A stream is re-checked by reopening it: the screen reconnects with its current session.
    const lifetime = setTimeout(() => {
      response.end();
    }, STREAM_LIFETIME_MS);
    const close = (): void => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
    };
    request.on('close', close);
    response.on('close', close);
  }
}
