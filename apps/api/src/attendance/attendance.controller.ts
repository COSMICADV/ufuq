/**
 * `/api/v1/attendance` — DOCUMENT 08 §4.4, every row of it.
 *
 * | Method | Endpoint                | Permission            |
 * | ------ | ----------------------- | --------------------- |
 * | POST   | `/attendance/check-in`  | attendance.check_in   |
 * | POST   | `/attendance/check-out` | attendance.check_out  |
 * | GET    | `/attendance/today`     | attendance.check_in   |
 * | GET    | `/attendance`           | attendance.view       |
 * | GET    | `/attendance/monthly`   | attendance.view       |
 * | GET    | `/attendance/summary`   | attendance.view       |
 * | PATCH  | `/attendance/{id}`      | attendance.update     |
 *
 * `PermissionsGuard` enforces the permission (DOCUMENT 09 §4 check 3); the
 * service resolves ownership scope (check 4). No handler reads a company id
 * from the request, and none accepts a client timestamp for "now"
 * (DOCUMENT 12 "Clock skew").
 *
 * Route order matters: `today`, `monthly` and `summary` are declared before
 * `:id`, or Nest would try to parse each of them as a UUID.
 */

import {
  Body,
  Controller,
  Get,
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
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  AdjustAttendanceDto,
  AttendanceListQueryDto,
  CheckInDto,
  MonthlyQueryDto,
  SummaryQueryDto,
} from './dto/attendance.dto.js';
import type { AttendancePayload } from './attendance-payload.js';
import { AttendanceService } from './attendance.service.js';
import type { MonthlyMatrix, TodayState } from './attendance.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly attendance: AttendanceService) {}

  @Post('check-in')
  @HttpCode(201)
  @RequirePermission('attendance.check_in')
  async checkIn(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CheckInDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AttendancePayload>> {
    return single(await this.attendance.checkIn(ctx, dto, origin), { locale });
  }

  @Post('check-out')
  @HttpCode(200)
  @RequirePermission('attendance.check_out')
  async checkOut(
    @CurrentUser() ctx: AuthContext,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AttendancePayload>> {
    return single(await this.attendance.checkOut(ctx, origin), { locale });
  }

  @Get('today')
  @RequirePermission('attendance.check_in')
  async today(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TodayState>> {
    return single(await this.attendance.today(ctx), { locale });
  }

  @Get('monthly')
  @RequirePermission('attendance.view')
  async monthly(
    @CurrentUser() ctx: AuthContext,
    @Query() query: MonthlyQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MonthlyMatrix>> {
    return single(await this.attendance.monthly(ctx, query), { locale });
  }

  @Get('summary')
  @RequirePermission('attendance.view')
  async summary(
    @CurrentUser() ctx: AuthContext,
    @Query() query: SummaryQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, number>>> {
    return single(await this.attendance.summary(ctx, query), { locale });
  }

  @Get()
  @RequirePermission('attendance.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: AttendanceListQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<AttendancePayload>> {
    const { items, total } = await this.attendance.list(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get(':id')
  @RequirePermission('attendance.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AttendancePayload>> {
    return single(await this.attendance.findOne(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('attendance.update')
  async adjust(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: AdjustAttendanceDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AttendancePayload>> {
    return single(await this.attendance.adjust(ctx, id, dto, origin), { locale });
  }
}
