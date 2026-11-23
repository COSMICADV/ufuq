import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { collection, single } from '../common/envelope.js';
import type { CollectionResponse, SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CareTeamDto,
  CheckInDto,
  NextPatientDto,
  QueueQueryDto,
  CreatePatientDto,
  CreateVisitDto,
  ListPatientsQueryDto,
  ListVisitsQueryDto,
  UpdatePatientDto,
  UpdateStaffDto,
  UpdateVisitDto,
} from './medical.dto.js';
import { MedicalService } from './medical.service.js';
import type {
  MedicalMePayload,
  PatientDetailPayload,
  PatientPayload,
  PersonRef,
  QueuePayload,
  StaffListPayload,
  StaffPayload,
  VisitPayload,
} from './medical.service.js';

const uuid = new ParseUUIDPipe();

/**
 * 1to1OS Business — Medical. No company role permission gates these routes:
 * the medical grants (per employee, set by the company admin) are checked
 * inside every service method, and a company that is not medical answers 404.
 */
@Controller('medical')
export class MedicalController {
  constructor(@Inject(MedicalService) private readonly medical: MedicalService) {}

  @Get('me')
  async me(@CurrentUser() ctx: AuthContext, @RequestLocale() locale: Locale): Promise<SingleResponse<MedicalMePayload>> {
    return single(await this.medical.me(ctx), { locale });
  }

  @Get('staff')
  async staff(@CurrentUser() ctx: AuthContext, @RequestLocale() locale: Locale): Promise<SingleResponse<StaffListPayload>> {
    return single(await this.medical.staff(ctx), { locale });
  }

  @Get('staff/options')
  async staffOptions(@CurrentUser() ctx: AuthContext, @RequestLocale() locale: Locale): Promise<SingleResponse<PersonRef[]>> {
    return single(await this.medical.staffOptions(ctx), { locale });
  }

  @Put('staff/:employeeId')
  async updateStaff(
    @CurrentUser() ctx: AuthContext,
    @Param('employeeId', uuid) employeeId: string,
    @Body() dto: UpdateStaffDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<StaffPayload>> {
    return single(await this.medical.updateStaff(ctx, employeeId, dto, origin), { locale });
  }

  @Get('patients')
  async patients(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListPatientsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<PatientPayload>> {
    const resolved = resolvePage(query);
    const { items, total } = await this.medical.patients(ctx, {
      ...(query.q ? { q: query.q } : {}),
      archived: query.archived === 'true',
      mine: query.mine === 'true',
      skip: resolved.skip,
      take: resolved.take,
    });
    return collection(items, total, resolved, { locale });
  }

  @Post('patients')
  async createPatient(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreatePatientDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.createPatient(ctx, dto, origin), { locale });
  }

  @Get('patients/:id')
  async patient(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.patient(ctx, id), { locale });
  }

  @Patch('patients/:id')
  async updatePatient(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdatePatientDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.updatePatient(ctx, id, dto, origin), { locale });
  }

  @Post('patients/:id/archive')
  async archive(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.setArchived(ctx, id, true, origin), { locale });
  }

  @Post('patients/:id/restore')
  async restore(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.setArchived(ctx, id, false, origin), { locale });
  }

  @Put('patients/:id/team')
  async team(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CareTeamDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PatientDetailPayload>> {
    return single(await this.medical.setCareTeam(ctx, id, dto, origin), { locale });
  }

  @Get('patients/:id/visits')
  async patientVisits(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload[]>> {
    return single(await this.medical.patientVisits(ctx, id), { locale });
  }

  @Post('patients/:id/visits')
  async createVisit(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: CreateVisitDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.createVisit(ctx, id, dto, origin), { locale });
  }

  @Get('visits')
  async visits(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListVisitsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload[]>> {
    return single(await this.medical.visits(ctx, new Date(query.from), new Date(query.to), query.mine === 'true'), { locale });
  }

  @Patch('visits/:id')
  async updateVisit(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateVisitDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.updateVisit(ctx, id, dto, origin), { locale });
  }

  // Reception (phase C1)

  @Get('queue')
  async queue(
    @CurrentUser() ctx: AuthContext,
    @Query() query: QueueQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<QueuePayload>> {
    return single(await this.medical.queue(ctx, query.date, query.doctor_id), { locale });
  }

  @Post('queue/check-in')
  async checkIn(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CheckInDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.checkIn(ctx, dto, origin), { locale });
  }

  @Post('queue/next')
  @HttpCode(200)
  async next(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: NextPatientDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload | null>> {
    return single(await this.medical.next(ctx, dto.doctor_id, origin), { locale });
  }

  @Post('visits/:id/start')
  @HttpCode(200)
  async start(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.advance(ctx, id, 'in_progress', origin), { locale });
  }

  @Post('visits/:id/finish')
  @HttpCode(200)
  async finish(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.advance(ctx, id, 'completed', origin), { locale });
  }

  @Post('visits/:id/no-show')
  @HttpCode(200)
  async noShow(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<VisitPayload>> {
    return single(await this.medical.advance(ctx, id, 'no_show', origin), { locale });
  }
}
