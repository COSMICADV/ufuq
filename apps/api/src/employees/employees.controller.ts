/**
 * `/api/v1/employees` — DOCUMENT 08 §4.3, the rows Phase 5 owns.
 *
 * | Method | Endpoint                     | Permission          |
 * | ------ | ---------------------------- | ------------------- |
 * | GET    | `/employees`                 | employee.view       |
 * | POST   | `/employees`                 | employee.create     |
 * | GET    | `/employees/{id}`            | employee.view       |
 * | PATCH  | `/employees/{id}`            | employee.update     |
 * | POST   | `/employees/{id}/deactivate` | employee.deactivate |
 * | POST   | `/employees/{id}/activate`   | employee.deactivate |
 * | POST   | `/employees/{id}/invite`     | employee.create     |
 *
 * The remaining §4.3 rows — salary, attendance, performance, monthly reports —
 * belong to Phases 11, 6, 8 and 12 and are not stubbed here.
 *
 * `PermissionsGuard` enforces the permission (DOCUMENT 09 §4 check 3); the
 * service resolves ownership scope (check 4). No handler reads a company id
 * from the request (DOCUMENT 08 §1).
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
import type { CollectionResponse, ResponseMeta, SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
} from './dto/employee.dto.js';
import type { EmployeePayload } from './employee-payload.js';
import { EmployeesService } from './employees.service.js';
import type { InvitationDeliveryOutcome } from './employees.service.js';

/** A malformed path id is 400 before any query runs (DOCUMENT 08 §3). */
const uuidParam = new ParseUUIDPipe();

/**
 * A write that may send an invitation reports what became of the email, so
 * the screen can say "created, but the invitation could not be sent — resend
 * it" instead of implying the employee has one (DOCUMENT 05 FLOW 20 rule 4).
 */
export interface EmployeeWriteMeta extends ResponseMeta {
  readonly invitation_delivery: InvitationDeliveryOutcome;
}

export interface EmployeeWriteResponse {
  readonly data: EmployeePayload;
  readonly meta: EmployeeWriteMeta;
}

@Controller('employees')
export class EmployeesController {
  constructor(@Inject(EmployeesService) private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermission('employee.view')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListEmployeesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<EmployeePayload>> {
    const { items, total } = await this.employees.list(ctx, query, locale);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Post()
  @RequirePermission('employee.create')
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateEmployeeDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<EmployeeWriteResponse> {
    const result = await this.employees.create(ctx, dto, origin);
    return {
      data: result.employee,
      meta: { locale, invitation_delivery: result.invitationDelivery },
    };
  }

  @Get(':id')
  @RequirePermission('employee.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeePayload>> {
    return single(await this.employees.get(ctx, id), { locale });
  }

  @Patch(':id')
  @RequirePermission('employee.update')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: UpdateEmployeeDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeePayload>> {
    return single(await this.employees.update(ctx, id, dto, origin), { locale });
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequirePermission('employee.deactivate')
  async deactivate(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: DeactivateEmployeeDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeePayload>> {
    return single(await this.employees.deactivate(ctx, id, dto, origin), { locale });
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('employee.deactivate')
  async activate(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<EmployeeWriteResponse> {
    const result = await this.employees.activate(ctx, id, origin);
    return {
      data: result.employee,
      meta: { locale, invitation_delivery: result.invitationDelivery },
    };
  }

  @Post(':id/invite')
  @HttpCode(200)
  @RequirePermission('employee.create')
  async invite(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeePayload>> {
    return single(await this.employees.invite(ctx, id, origin), { locale });
  }
}
