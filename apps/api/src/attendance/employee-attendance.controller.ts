/**
 * `GET /api/v1/employees/{id}/attendance` — DOCUMENT 08 §4.3.
 *
 * | Method | Endpoint                     | Permission      |
 * | ------ | ---------------------------- | --------------- |
 * | GET    | `/employees/{id}/attendance` | attendance.view |
 *
 * Lives with attendance rather than with employees: it is an attendance read
 * under the employee's path, and every rule it applies — the month, the
 * scope, the totals — is `AttendanceService`'s. The employees module does not
 * depend on attendance, and this keeps it that way.
 */

import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { EmployeeAttendanceQueryDto } from './dto/attendance.dto.js';
import { AttendanceService } from './attendance.service.js';
import type { EmployeeMonth } from './attendance.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('employees')
export class EmployeeAttendanceController {
  constructor(@Inject(AttendanceService) private readonly attendance: AttendanceService) {}

  @Get(':id/attendance')
  @RequirePermission('attendance.view')
  async month(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: EmployeeAttendanceQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeeMonth>> {
    return single(await this.attendance.employeeMonth(ctx, id, query), { locale });
  }
}
