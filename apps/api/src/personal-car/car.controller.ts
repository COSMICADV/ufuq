import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { CreateReadingDto, CreateVehicleDto, UpdateReadingDto, UpdateVehicleDto } from './car.dto.js';
import { PersonalCarService } from './car.service.js';
import type { ReadingPayload, VehicleDetailPayload, VehiclePayload } from './car.service.js';

const uuid = new ParseUUIDPipe();

/**
 * 1to1OS Personal — My Car. Every route needs `personal.car`, held only by
 * the `personal` role; row-level security keeps each account to its own rows.
 */
@Controller('personal/car')
@RequirePermission('personal.car')
export class PersonalCarController {
  constructor(@Inject(PersonalCarService) private readonly car: PersonalCarService) {}

  @Get('vehicles')
  async vehicles(
    @CurrentUser() ctx: AuthContext,
    @Query('include_archived') includeArchived: string | undefined,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VehiclePayload[]>> {
    return single(await this.car.vehicles(ctx, includeArchived === 'true'), { locale });
  }

  @Post('vehicles')
  async createVehicle(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateVehicleDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VehicleDetailPayload>> {
    return single(await this.car.createVehicle(ctx, dto), { locale });
  }

  @Get('vehicles/:id')
  async vehicle(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VehicleDetailPayload>> {
    return single(await this.car.vehicle(ctx, id), { locale });
  }

  @Patch('vehicles/:id')
  async updateVehicle(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateVehicleDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VehicleDetailPayload>> {
    return single(await this.car.updateVehicle(ctx, id, dto), { locale });
  }

  @Delete('vehicles/:id')
  async removeVehicle(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ archived: boolean }>> {
    return single(await this.car.removeVehicle(ctx, id), { locale });
  }

  @Post('vehicles/:id/restore')
  @HttpCode(204)
  async restoreVehicle(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.car.restoreVehicle(ctx, id);
  }

  @Post('vehicles/:id/readings')
  async addReading(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CreateReadingDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReadingPayload>> {
    return single(await this.car.addReading(ctx, id, dto), { locale });
  }

  @Patch('readings/:id')
  async updateReading(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateReadingDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReadingPayload>> {
    return single(await this.car.updateReading(ctx, id, dto), { locale });
  }

  @Delete('readings/:id')
  @HttpCode(204)
  async removeReading(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.car.removeReading(ctx, id);
  }
}
