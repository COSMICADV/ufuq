import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import type { AuthContext } from '../auth/auth-context.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/decorators/permissions.decorator.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import { BudgetsQueryDto, CreateBudgetDto, UpdateBudgetDto } from './budgets.dto.js';
import { PersonalBudgetsService } from './budgets.service.js';
import type { BudgetListPayload, BudgetPayload, BudgetPeriodPayload } from './budgets.service.js';

const uuid = new ParseUUIDPipe();

/**
 * 1to1OS Personal — budgets. Same gate as the rest of Expenses:
 * `personal.finance`, held only by the `personal` role.
 */
@Controller('personal/finance/budgets')
@RequirePermission('personal.finance')
export class PersonalBudgetsController {
  constructor(@Inject(PersonalBudgetsService) private readonly budgets: PersonalBudgetsService) {}

  @Get()
  async list(
    @CurrentUser() ctx: AuthContext,
    @Query() query: BudgetsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BudgetListPayload>> {
    return single(await this.budgets.list(ctx, query.month, query.include_archived === 'true'), { locale });
  }

  @Post()
  async create(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateBudgetDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BudgetPayload>> {
    return single(await this.budgets.create(ctx, dto), { locale });
  }

  @Get(':id')
  async get(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Query() query: BudgetsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BudgetPayload>> {
    return single(await this.budgets.get(ctx, id, query.month), { locale });
  }

  @Get(':id/history')
  async history(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BudgetPeriodPayload[]>> {
    return single(await this.budgets.history(ctx, id), { locale });
  }

  @Patch(':id')
  async update(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateBudgetDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<BudgetPayload>> {
    return single(await this.budgets.update(ctx, id, dto), { locale });
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.budgets.archive(ctx, id);
  }

  @Post(':id/restore')
  @HttpCode(204)
  async restore(@CurrentUser() ctx: AuthContext, @Param('id', uuid) id: string): Promise<void> {
    await this.budgets.restore(ctx, id);
  }
}
