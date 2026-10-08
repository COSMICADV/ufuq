/**
 * Leave endpoints — DOCUMENT 08 §4.6, and `/leave-types` from §4.2 (amended in
 * Phase 10: PATCH and DELETE so the documented settings screen can edit and
 * retire a type; `/cancel` serves both documented cancellations).
 *
 * | Method | Endpoint                         | Permission                                   |
 * | ------ | -------------------------------- | -------------------------------------------- |
 * | GET    | `/leave-types`                   | settings.view, or leave.request (active only) |
 * | POST   | `/leave-types`                   | leave.configure_types                        |
 * | PATCH  | `/leave-types/{id}`              | leave.configure_types                        |
 * | DELETE | `/leave-types/{id}`              | leave.configure_types (soft delete)          |
 * | GET    | `/leave-balances`                | leave.view (scope, plus own)                 |
 * | GET    | `/leave-balances/me`             | authenticated                                |
 * | PATCH  | `/leave-balances/{id}`           | leave.adjust_balance · reason required       |
 * | POST   | `/leave-requests`                | leave.request (JSON, or multipart with file) |
 * | GET    | `/leave-requests`                | leave.view (scope, plus own)                 |
 * | GET    | `/leave-requests/calculate`      | leave.request                                |
 * | GET    | `/leave-requests/{id}`           | scope-checked                                |
 * | POST   | `/leave-requests/{id}/approve`   | leave.approve                                |
 * | POST   | `/leave-requests/{id}/reject`    | leave.approve · reason required              |
 * | POST   | `/leave-requests/{id}/cancel`    | own pending; or ADMIN, approved, with reason |
 *
 * Literal paths (`me`, `calculate`) are declared before `:id`.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseBoolPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Locale } from '@ufuq/i18n';

import type { UploadedFile as UploadedFileShape } from '../attachments/attachments.service.js';
import { UploadTooLargeFilter } from '../attachments/upload-too-large.filter.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  AdjustLeaveBalanceDto,
  ApproveLeaveDto,
  CalculateLeaveQueryDto,
  CancelLeaveDto,
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  ListLeaveBalancesQueryDto,
  ListLeaveRequestsQueryDto,
  MyLeaveBalancesQueryDto,
  RejectLeaveDto,
  UpdateLeaveTypeDto,
} from './dto/leave.dto.js';
import { LeaveBalancesService } from './leave-balances.service.js';
import type {
  LeaveBalancePayload,
  LeaveRequestDetailPayload,
  LeaveRequestPayload,
  LeaveTypePayload,
} from './leave-payload.js';
import { LeaveRequestsService } from './leave-requests.service.js';
import type { LeaveCalculation, LeaveWriteResult } from './leave-requests.service.js';
import { LeaveTypesService } from './leave-types.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('leave-types')
export class LeaveTypesController {
  constructor(@Inject(LeaveTypesService) private readonly types: LeaveTypesService) {}

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query('include_retired', new ParseBoolPipe({ optional: true }))
    includeRetired: boolean | undefined,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<readonly LeaveTypePayload[]>> {
    return single(await this.types.list(ctx, includeRetired ?? false), { locale });
  }

  @Post()
  @HttpCode(201)
  @RequirePermission('leave.configure_types')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateLeaveTypeDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveTypePayload>> {
    return single(await this.types.create(ctx, dto, origin), { locale });
  }

  @Patch(':id')
  @RequirePermission('leave.configure_types')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateLeaveTypeDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveTypePayload>> {
    return single(await this.types.update(ctx, id, dto, origin), { locale });
  }

  @Delete(':id')
  @RequirePermission('leave.configure_types')
  async retire(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveTypePayload>> {
    return single(await this.types.retire(ctx, id, origin), { locale });
  }
}

@Controller('leave-balances')
export class LeaveBalancesController {
  constructor(@Inject(LeaveBalancesService) private readonly balances: LeaveBalancesService) {}

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListLeaveBalancesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<LeaveBalancePayload>> {
    const { items, total } = await this.balances.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get('me')
  async mine(
    @CurrentUser() ctx: AuthContext,
    @Query() query: MyLeaveBalancesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<readonly LeaveBalancePayload[]>> {
    return single(await this.balances.mine(ctx, query.year), { locale });
  }

  @Patch(':id')
  @RequirePermission('leave.adjust_balance')
  async adjust(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: AdjustLeaveBalanceDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveBalancePayload>> {
    return single(await this.balances.adjust(ctx, id, dto, origin), { locale });
  }
}

@Controller('leave-requests')
export class LeaveRequestsController {
  constructor(@Inject(LeaveRequestsService) private readonly leave: LeaveRequestsService) {}

  @Post()
  @HttpCode(201)
  @RequirePermission('leave.request')
  @UseInterceptors(FileInterceptor('file'))
  @UseFilters(UploadTooLargeFilter)
  async create(
    @CurrentUser() ctx: AuthContext,
    @UploadedFile() file: UploadedFileShape | undefined,
    @Body() dto: CreateLeaveRequestDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveWriteResult>> {
    return single(await this.leave.create(ctx, dto, file, origin), { locale });
  }

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListLeaveRequestsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<LeaveRequestPayload>> {
    const { items, total } = await this.leave.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get('calculate')
  @RequirePermission('leave.request')
  async calculate(
    @CurrentUser() ctx: AuthContext,
    @Query() query: CalculateLeaveQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveCalculation>> {
    return single(await this.leave.calculate(ctx, query), { locale });
  }

  @Get(':id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveRequestDetailPayload>> {
    return single(await this.leave.findOne(ctx, id), { locale });
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('leave.approve')
  async approve(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: ApproveLeaveDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveRequestDetailPayload>> {
    return single(await this.leave.approve(ctx, id, dto, origin), { locale });
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('leave.approve')
  async reject(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: RejectLeaveDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveRequestDetailPayload>> {
    return single(await this.leave.reject(ctx, id, dto, origin), { locale });
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CancelLeaveDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LeaveRequestDetailPayload>> {
    return single(await this.leave.cancel(ctx, id, dto, origin), { locale });
  }
}
