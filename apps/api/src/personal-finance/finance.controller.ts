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
import { RequestLocale } from '../common/request-locale.js';
import { resolvePage } from '../company-structure/dto/pagination.dto.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads DTO classes via emitDecoratorMetadata at runtime; `import type` would erase them from `design:paramtypes`.
import {
  CreateAccountDto,
  CreateCategoryDto,
  CreateTransactionDto,
  FinanceSettingsDto,
  ListTransactionsQueryDto,
  SummaryQueryDto,
  UpdateAccountDto,
  UpdateCategoryDto,
  UpdateTransactionDto,
} from './finance.dto.js';
import { PersonalFinanceService } from './finance.service.js';
import type {
  AccountPayload,
  CategoryPayload,
  SummaryPayload,
  TransactionPayload,
} from './finance.service.js';

const uuid = new ParseUUIDPipe();

/**
 * 1to1OS Personal — Expenses. Every route needs `personal.finance`, which
 * only the `personal` role holds, so no Business account reaches any of it;
 * row-level security keeps each Personal account to its own rows.
 */
@Controller('personal/finance')
@RequirePermission('personal.finance')
export class PersonalFinanceController {
  constructor(@Inject(PersonalFinanceService) private readonly finance: PersonalFinanceService) {}

  @Get('summary')
  async summary(
    @CurrentUser() ctx: AuthContext,
    @Query() query: SummaryQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<SummaryPayload>> {
    return single(await this.finance.summary(ctx, query, locale), { locale });
  }

  @Get('settings')
  async settings(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ currency: string; time_zone: string }>> {
    return single(await this.finance.settings(ctx), { locale });
  }

  @Patch('settings')
  async updateSettings(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: FinanceSettingsDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ currency: string }>> {
    return single(await this.finance.updateSettings(ctx, dto.currency), { locale });
  }

  // ---- Accounts
  @Get('accounts')
  async accounts(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AccountPayload[]>> {
    return single(await this.finance.listAccounts(ctx, locale), { locale });
  }

  @Post('accounts')
  @HttpCode(201)
  async createAccount(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateAccountDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AccountPayload>> {
    return single(await this.finance.createAccount(ctx, dto), { locale });
  }

  @Patch('accounts/:id')
  async updateAccount(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateAccountDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<AccountPayload>> {
    return single(await this.finance.updateAccount(ctx, id, dto), { locale });
  }

  @Delete('accounts/:id')
  async removeAccount(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ archived: boolean }>> {
    return single(await this.finance.removeAccount(ctx, id), { locale });
  }

  @Post('accounts/:id/restore')
  @HttpCode(204)
  async restoreAccount(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    await this.finance.restoreAccount(ctx, id);
  }

  // ---- Categories
  @Get('categories')
  async categories(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CategoryPayload[]>> {
    return single(await this.finance.listCategories(ctx, locale), { locale });
  }

  @Post('categories')
  @HttpCode(201)
  async createCategory(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateCategoryDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<CategoryPayload>> {
    return single(await this.finance.createCategory(ctx, dto), { locale });
  }

  @Patch('categories/:id')
  @HttpCode(204)
  async updateCategory(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<void> {
    await this.finance.updateCategory(ctx, id, dto);
  }

  @Delete('categories/:id')
  async removeCategory(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<{ archived: boolean }>> {
    return single(await this.finance.removeCategory(ctx, id), { locale });
  }

  @Post('categories/:id/restore')
  @HttpCode(204)
  async restoreCategory(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    await this.finance.restoreCategory(ctx, id);
  }

  // ---- Transactions
  @Get('transactions')
  async transactions(
    @CurrentUser() ctx: AuthContext,
    @Query() query: ListTransactionsQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<CollectionResponse<TransactionPayload>> {
    const page = resolvePage(query);
    const { items, total } = await this.finance.listTransactions(ctx, query, page);
    return collection(items, total, page, { locale });
  }

  @Post('transactions')
  @HttpCode(201)
  async createTransaction(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: CreateTransactionDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TransactionPayload>> {
    return single(await this.finance.createTransaction(ctx, dto), { locale });
  }

  @Get('transactions/:id')
  async transaction(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TransactionPayload>> {
    return single(await this.finance.getTransaction(ctx, id), { locale });
  }

  @Patch('transactions/:id')
  async updateTransaction(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
    @Body() dto: UpdateTransactionDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<TransactionPayload>> {
    return single(await this.finance.updateTransaction(ctx, id, dto), { locale });
  }

  @Delete('transactions/:id')
  @HttpCode(204)
  async removeTransaction(
    @CurrentUser() ctx: AuthContext,
    @Param('id', uuid) id: string,
  ): Promise<void> {
    await this.finance.removeTransaction(ctx, id);
  }
}
