/**
 * Salary and payroll endpoints — DOCUMENT 08 §4.2, §4.3, §4.10, §8.
 *
 * | Method | Endpoint                                   | Permission             |
 * | ------ | ------------------------------------------ | ---------------------- |
 * | GET    | `/salary-policies`                         | settings.view          |
 * | PATCH  | `/salary-policies`                         | settings.salary_policy |
 * | GET    | `/employees/{id}/salary`                   | employee.view_salary   |
 * | POST   | `/employees/{id}/salary`                   | employee.set_salary ·  Idempotency-Key |
 * | GET    | `/payroll/periods`                         | payroll.view (company) |
 * | GET    | `/payroll/periods/preflight`               | payroll.generate       |
 * | POST   | `/payroll/periods`                         | payroll.generate · Idempotency-Key |
 * | GET    | `/payroll/periods/{id}`                    | payroll.view (company) |
 * | POST   | `/payroll/periods/{id}/recalculate`        | payroll.generate       |
 * | POST   | `/payroll/periods/{id}/submit-review`      | payroll.approve        |
 * | POST   | `/payroll/periods/{id}/approve`            | payroll.approve        |
 * | POST   | `/payroll/periods/{id}/return-to-draft`    | payroll.approve        |
 * | POST   | `/payroll/periods/{id}/return-to-review`   | payroll.approve        |
 * | POST   | `/payroll/periods/{id}/finalize`           | payroll.finalize · `{ "confirm": "YYYY-MM" }` |
 * | POST   | `/payroll/periods/{id}/mark-paid`          | payroll.mark_paid      |
 * | GET    | `/payroll/lines`                           | payroll.view (finalized payslips) |
 * | GET    | `/payroll/lines/{id}`                      | payroll.view (self: own, finalized) |
 * | POST   | `/payroll/lines/{id}/deductions`           | payroll.add_deduction · Idempotency-Key |
 * | POST   | `/payroll/lines/{id}/bonuses`              | payroll.add_bonus · Idempotency-Key |
 * | POST   | `/payroll/lines/{id}/adjustments`          | payroll.adjust · Idempotency-Key |
 * | GET    | `/payroll/me`                              | payroll.view + employee.view_salary (own estimate) |
 * | GET    | `/payroll/me/history`                      | payroll.view + employee.view_salary (own payslips) |
 *
 * `return-to-draft` and `return-to-review` are DOCUMENT 15's two backward
 * transitions, which DOCUMENT 08 §4.10 did not list; they are added there.
 * Literal paths (`preflight`, `me`) are declared before `:id`.
 */

import {
  Body,
  Controller,
  Get,
  Headers,
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
import { idempotencyRequest } from '../common/idempotency.js';
import { RequestContext } from '../common/request-context.js';
import type { RequestOrigin } from '../common/request-context.js';
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreatePayrollAdjustmentDto,
  CreatePayrollEntryDto,
  FinalizePayrollDto,
  GeneratePayrollDto,
  ListPayrollLinesQueryDto,
  ListPayrollPeriodsQueryDto,
  PreflightQueryDto,
  RecalculatePayrollDto,
  SetSalaryDto,
  UpdateSalaryPolicyDto,
} from './dto/payroll.dto.js';
import { EmployeeSalaryService } from './employee-salary.service.js';
import type { EmployeeSalaryPayload } from './employee-salary.service.js';
import type { LineSummaryPayload, PayslipPayload, PeriodPayload } from './payroll-payload.js';
import { PayrollService } from './payroll.service.js';
import type { PayrollEstimate, PeriodDetail, Preflight } from './payroll.service.js';
import { SalaryPolicyService } from './salary-policy.service.js';
import type { SalaryPolicyPayload } from './salary-policy.service.js';

const uuidParam = new ParseUUIDPipe();
const IDEMPOTENCY_HEADER = 'idempotency-key';

@Controller('salary-policies')
export class SalaryPoliciesController {
  constructor(@Inject(SalaryPolicyService) private readonly policies: SalaryPolicyService) {}

  @Get()
  @RequirePermission('settings.view')
  async get(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ readonly policy: SalaryPolicyPayload | null }>> {
    return single(await this.policies.get(ctx), { locale });
  }

  @Patch()
  @RequirePermission('settings.salary_policy')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: UpdateSalaryPolicyDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ readonly policy: SalaryPolicyPayload }>> {
    return single(await this.policies.update(ctx, dto, origin), { locale });
  }
}

@Controller('employees')
export class EmployeeSalaryController {
  constructor(@Inject(EmployeeSalaryService) private readonly salaries: EmployeeSalaryService) {}

  @Get(':id/salary')
  @RequirePermission('employee.view_salary')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeeSalaryPayload>> {
    return single(await this.salaries.get(ctx, id), { locale });
  }

  @Post(':id/salary')
  @HttpCode(201)
  @RequirePermission('employee.set_salary')
  async set(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: SetSalaryDto,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<EmployeeSalaryPayload>> {
    const idempotency = idempotencyRequest(key, 'employee.salary', { id, ...dto });
    return single(await this.salaries.set(ctx, id, dto, idempotency, origin), { locale });
  }
}

@Controller('payroll')
export class PayrollController {
  constructor(@Inject(PayrollService) private readonly payroll: PayrollService) {}

  // -- Periods ------------------------------------------------------------------

  @Get('periods')
  @RequirePermission('payroll.view')
  async listPeriods(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListPayrollPeriodsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<PeriodPayload>> {
    const { items, total } = await this.payroll.listPeriods(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get('periods/preflight')
  @RequirePermission('payroll.generate')
  async preflight(
    @CurrentUser() ctx: AuthContext,
    @Query() query: PreflightQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Preflight>> {
    return single(await this.payroll.preflight(ctx, query.year, query.month), { locale });
  }

  @Post('periods')
  @HttpCode(201)
  @RequirePermission('payroll.generate')
  async generate(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: GeneratePayrollDto,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    const idempotency = idempotencyRequest(key, 'payroll.generate', dto);
    return single(await this.payroll.generate(ctx, dto, idempotency, origin), { locale });
  }

  @Get('periods/:id')
  @RequirePermission('payroll.view')
  async getPeriod(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.getPeriod(ctx, id), { locale });
  }

  @Post('periods/:id/recalculate')
  @HttpCode(200)
  @RequirePermission('payroll.generate')
  async recalculate(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: RecalculatePayrollDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.recalculate(ctx, id, dto, origin), { locale });
  }

  @Post('periods/:id/submit-review')
  @HttpCode(200)
  @RequirePermission('payroll.approve')
  async submitReview(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.transition(ctx, id, 'submit_review', origin), { locale });
  }

  @Post('periods/:id/approve')
  @HttpCode(200)
  @RequirePermission('payroll.approve')
  async approve(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.transition(ctx, id, 'approve', origin), { locale });
  }

  @Post('periods/:id/return-to-draft')
  @HttpCode(200)
  @RequirePermission('payroll.approve')
  async returnToDraft(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.transition(ctx, id, 'return_to_draft', origin), { locale });
  }

  @Post('periods/:id/return-to-review')
  @HttpCode(200)
  @RequirePermission('payroll.approve')
  async returnToReview(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.transition(ctx, id, 'return_to_review', origin), { locale });
  }

  @Post('periods/:id/finalize')
  @HttpCode(200)
  @RequirePermission('payroll.finalize')
  async finalize(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: FinalizePayrollDto,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.finalize(ctx, id, dto.confirm, origin), { locale });
  }

  @Post('periods/:id/mark-paid')
  @HttpCode(200)
  @RequirePermission('payroll.mark_paid')
  async markPaid(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PeriodDetail>> {
    return single(await this.payroll.markPaid(ctx, id, origin), { locale });
  }

  // -- Lines ----------------------------------------------------------------------

  @Get('lines')
  @RequirePermission('payroll.view')
  async listLines(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListPayrollLinesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<LineSummaryPayload>> {
    const { items, total } = await this.payroll.listLines(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }

  @Get('lines/:id')
  @RequirePermission('payroll.view')
  async getLine(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PayslipPayload>> {
    return single(await this.payroll.getLine(ctx, id), { locale });
  }

  @Post('lines/:id/deductions')
  @HttpCode(201)
  @RequirePermission('payroll.add_deduction')
  async addDeduction(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreatePayrollEntryDto,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PayslipPayload>> {
    const idempotency = idempotencyRequest(key, 'payroll.deduction', { id, ...dto });
    return single(await this.payroll.addEntry(ctx, id, 'deduction', dto, idempotency, origin), {
      locale,
    });
  }

  @Post('lines/:id/bonuses')
  @HttpCode(201)
  @RequirePermission('payroll.add_bonus')
  async addBonus(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreatePayrollEntryDto,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PayslipPayload>> {
    const idempotency = idempotencyRequest(key, 'payroll.bonus', { id, ...dto });
    return single(await this.payroll.addEntry(ctx, id, 'bonus', dto, idempotency, origin), {
      locale,
    });
  }

  @Post('lines/:id/adjustments')
  @HttpCode(201)
  @RequirePermission('payroll.adjust')
  async adjust(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body() dto: CreatePayrollAdjustmentDto,
    @Headers(IDEMPOTENCY_HEADER) key: string | undefined,
    @RequestContext() origin: RequestOrigin,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PayslipPayload>> {
    const idempotency = idempotencyRequest(key, 'payroll.adjustment', { id, ...dto });
    return single(await this.payroll.adjust(ctx, id, dto, idempotency, origin), { locale });
  }

  // -- The employee's own -------------------------------------------------------------

  @Get('me')
  @RequirePermission('payroll.view')
  async me(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<PayrollEstimate>> {
    return single(await this.payroll.me(ctx), { locale });
  }

  @Get('me/history')
  @RequirePermission('payroll.view')
  async myHistory(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListPayrollLinesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<LineSummaryPayload>> {
    const { items, total } = await this.payroll.myHistory(ctx, query);
    return collection(items, total, resolvePage(query), { locale });
  }
}
