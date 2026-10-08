/**
 * `/api/v1/company`, `/departments`, `/positions`, `/work-schedules`,
 * `/holidays` — DOCUMENT 08 §4.2, exactly the rows that table lists.
 *
 * The permissions on each handler are transcribed from that table:
 * `settings.view` to read, `settings.update` to write, and
 * `settings.work_schedule` for schedules specifically. `PermissionsGuard`
 * (Phase 3) enforces them on the server for every request, so a hidden button
 * is never the control (DOCUMENT 27 RULES 8 and 9).
 *
 * No handler takes a company identifier from anywhere — not the path, not the
 * query, not the body. `ctx.companyId` comes from the session
 * (DOCUMENT 08 §1's critical rule), and `withTenant` binds it to the database
 * transaction so row-level security enforces it even if a service someday
 * forgets a `where` clause (DOCUMENT 27 RULE 10).
 *
 * Five resources, one controller: they are one screen area (`/admin/settings`,
 * DOCUMENT 03 §3), one permission family, and one Nest module. Splitting them
 * into five controllers would mean five copies of the same envelope,
 * pagination and locale wiring.
 */

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

import { CompanyService } from './company.service.js';
import { DepartmentsService } from './departments.service.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { UpdateCompanyDto } from './dto/company.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above.
import { CreateDepartmentDto, UpdateDepartmentDto } from './dto/department.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above.
import { CreateHolidayDto } from './dto/holiday.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above.
import { PaginationQueryDto } from './dto/pagination.dto.js';
import { resolvePage } from './dto/pagination.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above.
import { CreatePositionDto } from './dto/position.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above.
import { CreateWorkScheduleDto, UpdateWorkScheduleDto } from './dto/work-schedule.dto.js';
import { HolidaysService } from './holidays.service.js';
import type {
  CompanyPayload,
  DepartmentPayload,
  CreatedHolidayPayload,
  HolidayPayload,
  PositionPayload,
  WorkSchedulePayload,
} from './payloads.js';
import { PositionsService } from './positions.service.js';
import { WorkSchedulesService } from './work-schedules.service.js';

/**
 * A path id that is not a UUID is malformed, not "not found" — 400, before any
 * query runs (DOCUMENT 08 §3). It also keeps a non-UUID from ever reaching a
 * `WHERE id = $1` against a `uuid` column, where PostgreSQL would answer with
 * a type error and a 500.
 */
const uuidParam = new ParseUUIDPipe();

@Controller()
export class CompanyStructureController {
  constructor(
    @Inject(CompanyService) private readonly company: CompanyService,
    @Inject(DepartmentsService) private readonly departments: DepartmentsService,
    @Inject(PositionsService) private readonly positions: PositionsService,
    @Inject(WorkSchedulesService) private readonly schedules: WorkSchedulesService,
    @Inject(HolidaysService) private readonly holidays: HolidaysService,
  ) {}

  // -- Company ---------------------------------------------------------------

  @Get('company')
  @RequirePermission('settings.view')
  async getCompany(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CompanyPayload>> {
    return single(await this.company.get(ctx), { locale });
  }

  @Patch('company')
  @RequirePermission('settings.update')
  async updateCompany(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: UpdateCompanyDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CompanyPayload>> {
    return single(await this.company.update(ctx, dto, origin), { locale });
  }

  // -- Departments -----------------------------------------------------------

  @Get('departments')
  @RequirePermission('settings.view')
  async listDepartments(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<DepartmentPayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.departments.list(ctx, page);
    return collection(items, total, page, { locale });
  }

  @Post('departments')
  @RequirePermission('settings.update')
  async createDepartment(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateDepartmentDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DepartmentPayload>> {
    return single(await this.departments.create(ctx, dto), { locale });
  }

  @Patch('departments/:id')
  @RequirePermission('settings.update')
  async updateDepartment(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateDepartmentDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<DepartmentPayload>> {
    return single(await this.departments.update(ctx, id, dto), { locale });
  }

  /** 204 — DOCUMENT 08 §3, "Deleted / no content". The delete is soft. */
  @Delete('departments/:id')
  @RequirePermission('settings.update')
  @HttpCode(204)
  async deleteDepartment(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
  ): Promise<void> {
    await this.departments.remove(ctx, id);
  }

  // -- Positions -------------------------------------------------------------

  @Get('positions')
  @RequirePermission('settings.view')
  async listPositions(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<PositionPayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.positions.list(ctx, page);
    return collection(items, total, page, { locale });
  }

  @Post('positions')
  @RequirePermission('settings.update')
  async createPosition(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreatePositionDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PositionPayload>> {
    return single(await this.positions.create(ctx, dto), { locale });
  }

  // -- Work schedules --------------------------------------------------------

  @Get('work-schedules')
  @RequirePermission('settings.view')
  async listWorkSchedules(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<WorkSchedulePayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.schedules.list(ctx, page);
    return collection(items, total, page, { locale });
  }

  @Post('work-schedules')
  @RequirePermission('settings.work_schedule')
  async createWorkSchedule(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateWorkScheduleDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WorkSchedulePayload>> {
    return single(await this.schedules.create(ctx, dto, origin), { locale });
  }

  @Patch('work-schedules/:id')
  @RequirePermission('settings.work_schedule')
  async updateWorkSchedule(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateWorkScheduleDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<WorkSchedulePayload>> {
    return single(await this.schedules.update(ctx, id, dto, origin), { locale });
  }

  // -- Holidays --------------------------------------------------------------

  @Get('holidays')
  @RequirePermission('settings.view')
  async listHolidays(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PaginationQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<HolidayPayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.holidays.list(ctx, page);
    return collection(items, total, page, { locale });
  }

  @Post('holidays')
  @RequirePermission('settings.update')
  async createHoliday(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateHolidayDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CreatedHolidayPayload>> {
    return single(await this.holidays.create(ctx, dto, origin), { locale });
  }
}
