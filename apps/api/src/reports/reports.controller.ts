/**
 * Reports — DOCUMENT 08 §4.12 (amended in Phase 12), DOCUMENT 18.
 *
 * | Method | Path                                                       | Permission                                  |
 * | ------ | ---------------------------------------------------------- | ------------------------------------------- |
 * | GET    | `/reports/attendance`                                      | report.company / report.team                |
 * | GET    | `/reports/performance`                                     | report.company / report.team                |
 * | GET    | `/reports/tasks`                                           | report.company / report.team                |
 * | GET    | `/reports/goals`                                           | report.company / report.team                |
 * | GET    | `/reports/payroll`                                         | report.company                              |
 * | GET    | `/reports/inventory`                                       | report.company                              |
 * | GET    | `/reports/warehouse`                                       | report.company — added in Phase 12          |
 * | GET    | `/reports/stock-movements`                                 | report.company                              |
 * | POST   | `/reports/{key}/export`                                    | report.export **and** the report's own read |
 * | GET    | `/reports/exports/{id}`                                    | report.export · the requester only          |
 * | GET    | `/reports/exports/{id}/download`                           | report.export · the requester only          |
 * | GET    | `/reports/employee/{id}/monthly?month=YYYY-MM`             | report.employee_monthly                     |
 * | POST   | `/reports/employee/{id}/monthly/{year}/{month}/generate`   | report.employee_monthly                     |
 * | POST   | `/reports/employee/{id}/monthly/{year}/{month}/regenerate` | report.employee_monthly (company/team)      |
 * | GET    | `/employees/{id}/monthly-reports`                          | report.employee_monthly                     |
 *
 * People reports declare `report.team` — the grant both ADMIN (company
 * scope) and MANAGER (team scope) hold — and the service resolves the scope
 * (`report.company` reads the whole company). Company-only reports declare
 * `report.company`, which no MANAGER holds. Every `/reports` read, export and
 * monthly-report call is rate limited (20/hour/user).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';
import type { Response } from 'express';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  ExportReportDto,
  MonthlyReportParamsDto,
  MonthlyReportQueryDto,
  ReportQueryDto,
} from './dto/reports.dto.js';
import { MonthlyReportsService, parseMonthKey } from './monthly-reports.service.js';
import type { MonthlyReportListItem, MonthlyReportPayload } from './monthly-reports.service.js';
import { isReportKey } from './report-catalogue.js';
import type { ReportKey } from './report-catalogue.js';
import { ReportExportService } from './report-exports.js';
import type { ExportPayload } from './report-exports.js';
import { ReportRateLimitGuard } from './report-rate-limit.guard.js';
import type { ReportPayload } from './report-types.js';
import { ReportsService } from './reports.service.js';

const uuidParam = new ParseUUIDPipe();

@Controller('reports')
@UseGuards(ReportRateLimitGuard)
export class ReportsController {
  constructor(
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(ReportExportService) private readonly exports: ReportExportService,
    @Inject(MonthlyReportsService) private readonly monthly: MonthlyReportsService,
  ) {}

  private async read(
    ctx: AuthContext,
    key: ReportKey,
    query: ReportQueryDto,
    locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return single(await this.reports.read(ctx, key, query), { locale });
  }

  @Get('attendance')
  @RequirePermission('report.team')
  attendance(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'attendance', query, locale);
  }

  @Get('performance')
  @RequirePermission('report.team')
  performance(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'performance', query, locale);
  }

  @Get('tasks')
  @RequirePermission('report.team')
  tasks(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'tasks', query, locale);
  }

  @Get('goals')
  @RequirePermission('report.team')
  goals(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'goals', query, locale);
  }

  @Get('payroll')
  @RequirePermission('report.company')
  payroll(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'payroll', query, locale);
  }

  @Get('inventory')
  @RequirePermission('report.company')
  inventory(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'inventory', query, locale);
  }

  @Get('warehouse')
  @RequirePermission('report.company')
  warehouse(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'warehouse', query, locale);
  }

  @Get('stock-movements')
  @RequirePermission('report.company')
  stockMovements(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ReportPayload>> {
    return this.read(ctx, 'stock-movements', query, locale);
  }

  /** 200 `text/csv` for a normal export; 202 with the queued export for a large one. */
  @Post(':key/export')
  @HttpCode(200)
  @RequirePermission('report.export')
  async export(
    @CurrentUser() ctx: AuthContext,
    @Param('key') key: string,
    @Body() dto: ExportReportDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | SingleResponse<ExportPayload>> {
    if (!isReportKey(key)) {
      throw new NotFoundException();
    }
    const outcome = await this.exports.export(ctx, key, dto, locale, origin);
    if (outcome.kind === 'queued') {
      response.status(202);
      return single(outcome.export, { locale });
    }
    response.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${outcome.filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'X-Report-Rows': String(outcome.rowCount),
    });
    return new StreamableFile(outcome.body);
  }

  // -- Monthly employee reports -------------------------------------------------

  @Get('employee/:id/monthly')
  @RequirePermission('report.employee_monthly')
  async monthlyReport(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Query() query: MonthlyReportQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MonthlyReportPayload>> {
    return single(await this.monthly.get(ctx, id, parseMonthKey(query.month)), { locale });
  }

  @Post('employee/:id/monthly/:year/:month/generate')
  @HttpCode(200)
  @RequirePermission('report.employee_monthly')
  async generate(
    @CurrentUser() ctx: AuthContext,
    @Param() params: MonthlyReportParamsDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SingleResponse<MonthlyReportPayload>> {
    const result = await this.monthly.generate(ctx, params.id, params.year, params.month, origin);
    // 201 for a snapshot this request created; 200 for one that already existed.
    response.status(result.created ? 201 : 200);
    return single(result.report, { locale });
  }

  @Post('employee/:id/monthly/:year/:month/regenerate')
  @HttpCode(200)
  @RequirePermission('report.employee_monthly')
  async regenerate(
    @CurrentUser() ctx: AuthContext,
    @Param() params: MonthlyReportParamsDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<MonthlyReportPayload>> {
    return single(
      await this.monthly.regenerate(ctx, params.id, params.year, params.month, origin),
      { locale },
    );
  }
}

/**
 * A queued export's status and file. Not rate limited: they read a finished
 * job, they do not run a report (see `report-rate-limit.guard.ts`).
 */
@Controller('reports/exports')
export class ReportExportsController {
  constructor(@Inject(ReportExportService) private readonly exports: ReportExportService) {}

  @Get(':id')
  @RequirePermission('report.export')
  async status(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<ExportPayload>> {
    return single(await this.exports.status(ctx, id), { locale });
  }

  @Get(':id/download')
  @RequirePermission('report.export')
  async download(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.exports.download(ctx, id);
    response.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.stream);
  }
}

/** DOCUMENT 08 §4.3: an employee's monthly reports, newest first. */
@Controller('employees')
export class EmployeeMonthlyReportsController {
  constructor(@Inject(MonthlyReportsService) private readonly monthly: MonthlyReportsService) {}

  @Get(':id/monthly-reports')
  @RequirePermission('report.employee_monthly')
  async list(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<readonly MonthlyReportListItem[]>> {
    return single(await this.monthly.list(ctx, id), { locale });
  }
}
