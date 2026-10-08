/**
 * Performance endpoints — DOCUMENT 14 "API requirements".
 *
 * | Method | Endpoint                      | Permission                    |
 * | ------ | ----------------------------- | ----------------------------- |
 * | GET    | `/performance-config`         | settings.view                 |
 * | PATCH  | `/performance-config`         | settings.performance_weights  |
 * | GET    | `/employees/{id}/performance` | report.employee_monthly       |
 *
 * The guard enforces each permission; the service resolves the employee
 * scope. DOCUMENT 08 §4.2 and §4.3 name these routes in two different tables,
 * which is why the controller has no common prefix.
 */

import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { EmployeePerformanceQueryDto, UpdatePerformanceConfigDto } from './dto/performance.dto.js';
import { PerformanceService } from './performance.service.js';
import type {
  EmployeePerformancePayload,
  PerformanceConfigPayload,
} from './performance.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller()
export class PerformanceController {
  constructor(@Inject(PerformanceService) private readonly performance: PerformanceService) {}

  @Get('performance-config')
  @RequirePermission('settings.view')
  async getConfig(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PerformanceConfigPayload>> {
    return single(await this.performance.getConfig(ctx), { locale });
  }

  @Patch('performance-config')
  @RequirePermission('settings.performance_weights')
  async updateConfig(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: UpdatePerformanceConfigDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PerformanceConfigPayload>> {
    return single(await this.performance.updateConfig(ctx, dto, origin), { locale });
  }

  @Get('employees/:id/performance')
  @RequirePermission('report.employee_monthly')
  async employeePerformance(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: EmployeePerformanceQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeePerformancePayload>> {
    return single(await this.performance.employeePerformance(ctx, id, query), { locale });
  }
}
