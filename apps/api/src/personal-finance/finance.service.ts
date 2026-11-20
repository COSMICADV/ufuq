/**
 * 1to1OS Personal — Expenses, phase 1.
 *
 * Balances are never stored. An account's balance is its opening balance
 * plus income into it, minus expenses and transfers out of it, plus transfers
 * into it — summed in PostgreSQL over NUMERIC, so no floating point is ever
 * involved and a balance cannot drift from the transactions it summarises.
 *
 * A transfer is neither income nor expense: it only moves money between two
 * of the person's own accounts (a savings contribution, a credit-card
 * repayment, cash taken from the bank). A credit card is an account whose
 * balance goes negative as it is used; repaying it is a transfer into it, so
 * a purchase on the card is counted once — as the expense it was.
 *
 * Every query runs inside the account's tenant scope (row-level security on
 * company_id); a Personal workspace has exactly one user, and every row also
 * records it. Nothing here writes amounts, merchants or notes to logs.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient , Prisma } from '@ufuq/db';
import type { Locale } from '@ufuq/i18n';
import { Decimal } from '@ufuq/money';

import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { ResolvedPage } from '../company-structure/dto/pagination.dto.js';
import {
  fieldError,
  isUniqueViolation,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import type {
  CreateAccountDto,
  CreateCategoryDto,
  CreateTransactionDto,
  ListTransactionsQueryDto,
  SummaryQueryDto,
  UpdateAccountDto,
  UpdateCategoryDto,
  UpdateTransactionDto,
} from './finance.dto.js';
import {
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
  periodRange,
} from './finance-rules.js';
import type { AccountTypeValue, TransactionTypeValue } from './finance-rules.js';

const MONEY = 2;
const money = (value: string): Decimal => Decimal.parse(value, MONEY);

export interface AccountPayload {
  readonly id: string;
  readonly name: string;
  readonly type: AccountTypeValue;
  readonly currency: string;
  readonly opening_balance: string;
  readonly balance: string;
  readonly archived: boolean;
  readonly transaction_count: number;
}

export interface CategoryPayload {
  readonly id: string;
  readonly kind: 'expense' | 'income';
  readonly key: string | null;
  readonly name: string | null;
  readonly parent_id: string | null;
  readonly position: number;
  readonly archived: boolean;
}

export interface TransactionPayload {
  readonly id: string;
  readonly type: TransactionTypeValue;
  readonly amount: string;
  readonly currency: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly to_account_id: string | null;
  readonly to_account_name: string | null;
  readonly category_id: string | null;
  readonly category_key: string | null;
  readonly category_name: string | null;
  readonly occurred_at: string;
  readonly merchant: string | null;
  readonly notes: string | null;
}

export interface SummaryPayload {
  readonly currency: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly available: readonly { readonly currency: string; readonly amount: string }[];
  readonly credit_owed: readonly { readonly currency: string; readonly amount: string }[];
  readonly income: string;
  readonly expense: string;
  readonly net: string;
  readonly by_category: readonly {
    readonly category_id: string | null;
    readonly key: string | null;
    readonly name: string | null;
    readonly amount: string;
  }[];
  readonly accounts: readonly AccountPayload[];
  readonly recent: readonly TransactionPayload[];
  readonly other_currencies: boolean;
}

const TRANSACTION_INCLUDE = {
  account: { select: { name: true } },
  toAccount: { select: { name: true } },
  category: { select: { key: true, name: true } },
} as const;

type TransactionRow = Prisma.FinanceTransactionGetPayload<{
  include: typeof TRANSACTION_INCLUDE;
}>;

function transactionPayload(row: TransactionRow): TransactionPayload {
  return {
    id: row.id,
    type: row.type,
    amount: money(row.amount.toString()).toString(),
    currency: row.currency,
    account_id: row.accountId,
    account_name: row.account.name,
    to_account_id: row.toAccountId,
    to_account_name: row.toAccount?.name ?? null,
    category_id: row.categoryId,
    category_key: row.category?.key ?? null,
    category_name: row.category?.name ?? null,
    occurred_at: row.occurredAt.toISOString(),
    merchant: row.merchant,
    notes: row.notes,
  };
}

const CASH_WALLET: Record<Locale, string> = {
  ar: 'محفظة الكاش',
  en: 'Cash wallet',
  fr: 'Portefeuille espèces',
  it: 'Portafoglio contanti',
  de: 'Bargeld',
};

@Injectable()
export class PersonalFinanceService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  // ---- Setup -------------------------------------------------------------

  /** The default categories and a cash wallet, the first time Expenses opens. */
  private async ensureDefaults(tx: TenantClient, ctx: AuthContext, locale: Locale): Promise<void> {
    const hasCategories = await tx.financeCategory.count({ where: { key: { not: null } } });
    if (hasCategories === 0) {
      await tx.financeCategory.createMany({
        data: [
          ...DEFAULT_EXPENSE_CATEGORIES.map((key, position) => ({
            id: generateId(),
            companyId: ctx.companyId,
            userId: ctx.userId,
            kind: 'expense' as const,
            key,
            position,
          })),
          ...DEFAULT_INCOME_CATEGORIES.map((key, position) => ({
            id: generateId(),
            companyId: ctx.companyId,
            userId: ctx.userId,
            kind: 'income' as const,
            key,
            position,
          })),
        ],
        skipDuplicates: true,
      });
    }
    const hasAccounts = await tx.financeAccount.count();
    if (hasAccounts === 0) {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { currency: true },
      });
      await tx.financeAccount.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          name: CASH_WALLET[locale],
          type: 'cash',
          currency: company.currency,
        },
      });
    }
  }

  async settings(ctx: AuthContext): Promise<{ currency: string; time_zone: string }> {
    return this.tenant(ctx, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { currency: true, timezone: true },
      });
      return { currency: company.currency, time_zone: company.timezone };
    });
  }

  async updateSettings(ctx: AuthContext, currency: string): Promise<{ currency: string }> {
    return this.tenant(ctx, async (tx) => {
      await tx.company.update({ where: { id: ctx.companyId }, data: { currency } });
      return { currency };
    });
  }

  // ---- Accounts ----------------------------------------------------------

  private async accountRows(tx: TenantClient): Promise<AccountPayload[]> {
    const rows = await tx.$queryRaw<
      {
        id: string;
        name: string;
        type: AccountTypeValue;
        currency: string;
        opening_balance: string;
        balance: string;
        archived: boolean;
        transaction_count: number;
      }[]
    >`
      SELECT a.id, a.name, a.type::text AS type, a.currency,
             a.opening_balance::text AS opening_balance,
             (a.opening_balance
               + COALESCE((SELECT SUM(t.amount) FROM finance_transactions t
                           WHERE t.account_id = a.id AND t.type = 'income'), 0)
               - COALESCE((SELECT SUM(t.amount) FROM finance_transactions t
                           WHERE t.account_id = a.id AND t.type IN ('expense', 'transfer')), 0)
               + COALESCE((SELECT SUM(t.amount) FROM finance_transactions t
                           WHERE t.to_account_id = a.id AND t.type = 'transfer'), 0)
             )::text AS balance,
             (a.archived_at IS NOT NULL) AS archived,
             (SELECT COUNT(*)::int FROM finance_transactions t
               WHERE t.account_id = a.id OR t.to_account_id = a.id) AS transaction_count
        FROM finance_accounts a
       ORDER BY (a.archived_at IS NOT NULL), a.created_at`;
    return rows.map((row) => ({
      ...row,
      opening_balance: money(row.opening_balance).toString(),
      balance: money(row.balance).toString(),
    }));
  }

  async listAccounts(ctx: AuthContext, locale: Locale): Promise<AccountPayload[]> {
    return this.tenant(ctx, async (tx) => {
      await this.ensureDefaults(tx, ctx, locale);
      return this.accountRows(tx);
    });
  }

  private openingFor(
    type: AccountTypeValue,
    dto: { opening_balance?: string; owed?: string },
  ): string | undefined {
    if (type === 'credit_card' && dto.owed !== undefined)
      return money(dto.owed).negate().toString();
    return dto.opening_balance;
  }

  async createAccount(ctx: AuthContext, dto: CreateAccountDto): Promise<AccountPayload> {
    return this.tenant(ctx, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { currency: true },
      });
      const id = generateId();
      try {
        await tx.financeAccount.create({
          data: {
            id,
            companyId: ctx.companyId,
            userId: ctx.userId,
            name: dto.name,
            type: dto.type,
            currency: dto.currency ?? company.currency,
            openingBalance: this.openingFor(dto.type, dto) ?? '0',
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw fieldError({ name: ['already_taken'] });
        throw error;
      }
      const all = await this.accountRows(tx);
      const created = all.find((a) => a.id === id);
      if (!created) throw notFound();
      return created;
    });
  }

  async updateAccount(
    ctx: AuthContext,
    id: string,
    dto: UpdateAccountDto,
  ): Promise<AccountPayload> {
    return this.tenant(ctx, async (tx) => {
      const account = await tx.financeAccount.findUnique({ where: { id } });
      if (!account) throw notFound();
      const type = dto.type ?? account.type;
      if (dto.currency !== undefined && dto.currency !== account.currency) {
        const used = await tx.financeTransaction.count({
          where: { OR: [{ accountId: id }, { toAccountId: id }] },
        });
        if (used > 0) throw fieldError({ currency: ['not_allowed'] });
      }
      const opening = this.openingFor(type, dto);
      try {
        await tx.financeAccount.update({
          where: { id },
          data: {
            ...(dto.name === undefined ? {} : { name: dto.name }),
            ...(dto.type === undefined ? {} : { type: dto.type }),
            ...(dto.currency === undefined ? {} : { currency: dto.currency }),
            ...(opening === undefined ? {} : { openingBalance: opening }),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw fieldError({ name: ['already_taken'] });
        throw error;
      }
      const updated = (await this.accountRows(tx)).find((a) => a.id === id);
      if (!updated) throw notFound();
      return updated;
    });
  }

  /** Deletes an unused account; one with transactions is archived instead, keeping its history. */
  async removeAccount(ctx: AuthContext, id: string): Promise<{ archived: boolean }> {
    return this.tenant(ctx, async (tx) => {
      const account = await tx.financeAccount.findUnique({ where: { id } });
      if (!account) throw notFound();
      const used = await tx.financeTransaction.count({
        where: { OR: [{ accountId: id }, { toAccountId: id }] },
      });
      if (used > 0) {
        await tx.financeAccount.update({ where: { id }, data: { archivedAt: new Date() } });
        return { archived: true };
      }
      await tx.financeAccount.delete({ where: { id } });
      return { archived: false };
    });
  }

  async restoreAccount(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const account = await tx.financeAccount.findUnique({ where: { id } });
      if (!account) throw notFound();
      await tx.financeAccount.update({ where: { id }, data: { archivedAt: null } });
    });
  }

  // ---- Categories --------------------------------------------------------

  async listCategories(ctx: AuthContext, locale: Locale): Promise<CategoryPayload[]> {
    return this.tenant(ctx, async (tx) => {
      await this.ensureDefaults(tx, ctx, locale);
      const rows = await tx.financeCategory.findMany({
        orderBy: [{ kind: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      });
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        key: row.key,
        name: row.name,
        parent_id: row.parentId,
        position: row.position,
        archived: row.archivedAt !== null,
      }));
    });
  }

  async createCategory(ctx: AuthContext, dto: CreateCategoryDto): Promise<CategoryPayload> {
    return this.tenant(ctx, async (tx) => {
      if (dto.parent_id !== undefined) {
        const parent = await tx.financeCategory.findUnique({ where: { id: dto.parent_id } });
        if (!parent || parent.parentId !== null || parent.kind !== dto.kind)
          throw fieldError({ parent_id: ['invalid'] });
      }
      const position = await tx.financeCategory.count({ where: { kind: dto.kind } });
      const row = await tx.financeCategory.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          kind: dto.kind,
          name: dto.name,
          parentId: dto.parent_id ?? null,
          position,
        },
      });
      return {
        id: row.id,
        kind: row.kind,
        key: row.key,
        name: row.name,
        parent_id: row.parentId,
        position: row.position,
        archived: false,
      };
    });
  }

  async updateCategory(ctx: AuthContext, id: string, dto: UpdateCategoryDto): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.financeCategory.findUnique({ where: { id } });
      if (!row) throw notFound();
      await tx.financeCategory.update({
        where: { id },
        data: {
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.position === undefined ? {} : { position: dto.position }),
        },
      });
    });
  }

  /** Deletes an unused category; a used one (or one with subcategories) is archived. */
  async removeCategory(ctx: AuthContext, id: string): Promise<{ archived: boolean }> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.financeCategory.findUnique({ where: { id } });
      if (!row) throw notFound();
      const used =
        (await tx.financeTransaction.count({ where: { categoryId: id } })) +
        (await tx.financeCategory.count({ where: { parentId: id } }));
      if (used > 0 || row.key !== null) {
        await tx.financeCategory.update({ where: { id }, data: { archivedAt: new Date() } });
        return { archived: true };
      }
      await tx.financeCategory.delete({ where: { id } });
      return { archived: false };
    });
  }

  async restoreCategory(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.financeCategory.findUnique({ where: { id } });
      if (!row) throw notFound();
      await tx.financeCategory.update({ where: { id }, data: { archivedAt: null } });
    });
  }

  // ---- Transactions ------------------------------------------------------

  /**
   * Checks a transaction's shape against the person's own records and
   * returns the currency it is recorded in (always its account's).
   */
  private async validate(
    tx: TenantClient,
    input: {
      readonly type: TransactionTypeValue;
      readonly accountId: string;
      readonly toAccountId: string | null;
      readonly categoryId: string | null;
    },
    existing?: {
      readonly accountId: string;
      readonly toAccountId: string | null;
      readonly categoryId: string | null;
    },
  ): Promise<string> {
    const account = await tx.financeAccount.findUnique({ where: { id: input.accountId } });
    // An archived account keeps the transactions it already has.
    if (!account || (account.archivedAt !== null && existing?.accountId !== account.id))
      throw fieldError({ account_id: ['not_found'] });
    if (input.type === 'transfer') {
      if (input.categoryId !== null) throw fieldError({ category_id: ['not_allowed'] });
      if (input.toAccountId === null) throw fieldError({ to_account_id: ['required'] });
      if (input.toAccountId === input.accountId) throw fieldError({ to_account_id: ['invalid'] });
      const to = await tx.financeAccount.findUnique({ where: { id: input.toAccountId } });
      if (!to || (to.archivedAt !== null && existing?.toAccountId !== to.id))
        throw fieldError({ to_account_id: ['not_found'] });
      if (to.currency !== account.currency) throw fieldError({ to_account_id: ['mismatch'] });
    } else {
      if (input.toAccountId !== null) throw fieldError({ to_account_id: ['not_allowed'] });
      if (input.categoryId !== null) {
        const category = await tx.financeCategory.findUnique({ where: { id: input.categoryId } });
        if (
          !category ||
          category.kind !== input.type ||
          (category.archivedAt !== null && existing?.categoryId !== category.id)
        )
          throw fieldError({ category_id: ['invalid'] });
      }
    }
    return account.currency;
  }

  async listTransactions(
    ctx: AuthContext,
    query: ListTransactionsQueryDto,
    page: ResolvedPage,
  ): Promise<{ items: TransactionPayload[]; total: number }> {
    return this.tenant(ctx, async (tx) => {
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { timezone: true },
      });
      const range =
        query.from !== undefined || query.to !== undefined
          ? periodRange('custom', new Date(), company.timezone, {
              from: query.from ?? query.to,
              to: query.to ?? query.from,
            })
          : null;
      if ((query.from !== undefined || query.to !== undefined) && range === null)
        throw fieldError({ from: ['invalid'] });
      const where: Prisma.FinanceTransactionWhereInput = {
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.account_id === undefined
          ? {}
          : { OR: [{ accountId: query.account_id }, { toAccountId: query.account_id }] }),
        ...(query.category_id === undefined
          ? {}
          : {
              OR: [
                { categoryId: query.category_id },
                { category: { parentId: query.category_id } },
              ],
            }),
        ...(range === null ? {} : { occurredAt: { gte: range.from, lt: range.to } }),
        ...(query.q === undefined || query.q === ''
          ? {}
          : {
              AND: [
                {
                  OR: [
                    { merchant: { contains: query.q, mode: 'insensitive' } },
                    { notes: { contains: query.q, mode: 'insensitive' } },
                  ],
                },
              ],
            }),
      };
      // Account and category filters both use OR; combine them safely.
      if (query.account_id !== undefined && query.category_id !== undefined) {
        delete where.OR;
        where.AND = [
          ...((where.AND as Prisma.FinanceTransactionWhereInput[] | undefined) ?? []),
          { OR: [{ accountId: query.account_id }, { toAccountId: query.account_id }] },
          {
            OR: [{ categoryId: query.category_id }, { category: { parentId: query.category_id } }],
          },
        ];
      }
      const [rows, total] = await Promise.all([
        tx.financeTransaction.findMany({
          where,
          include: TRANSACTION_INCLUDE,
          orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.financeTransaction.count({ where }),
      ]);
      return { items: rows.map(transactionPayload), total };
    });
  }

  async getTransaction(ctx: AuthContext, id: string): Promise<TransactionPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await tx.financeTransaction.findUnique({
        where: { id },
        include: TRANSACTION_INCLUDE,
      });
      if (!row) throw notFound();
      return transactionPayload(row);
    });
  }

  async createTransaction(
    ctx: AuthContext,
    dto: CreateTransactionDto,
  ): Promise<TransactionPayload> {
    return this.tenant(ctx, async (tx) => {
      const currency = await this.validate(tx, {
        type: dto.type,
        accountId: dto.account_id,
        toAccountId: dto.to_account_id ?? null,
        categoryId: dto.category_id ?? null,
      });
      const row = await tx.financeTransaction.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          type: dto.type,
          amount: dto.amount,
          currency,
          accountId: dto.account_id,
          toAccountId: dto.to_account_id ?? null,
          categoryId: dto.type === 'transfer' ? null : (dto.category_id ?? null),
          occurredAt: new Date(dto.occurred_at),
          merchant: dto.merchant || null,
          notes: dto.notes || null,
        },
        include: TRANSACTION_INCLUDE,
      });
      return transactionPayload(row);
    });
  }

  /** The type is fixed once recorded; everything else may change, and is checked again. */
  async updateTransaction(
    ctx: AuthContext,
    id: string,
    dto: UpdateTransactionDto,
  ): Promise<TransactionPayload> {
    return this.tenant(ctx, async (tx) => {
      const existing = await tx.financeTransaction.findUnique({ where: { id } });
      if (!existing) throw notFound();
      const next = {
        type: existing.type,
        accountId: dto.account_id ?? existing.accountId,
        toAccountId:
          existing.type === 'transfer' ? (dto.to_account_id ?? existing.toAccountId) : null,
        categoryId:
          existing.type === 'transfer'
            ? null
            : dto.category_id !== undefined
              ? dto.category_id
              : existing.categoryId,
      };
      if (existing.type !== 'transfer' && dto.to_account_id !== undefined)
        throw fieldError({ to_account_id: ['not_allowed'] });
      if (existing.type === 'transfer' && dto.category_id !== undefined)
        throw fieldError({ category_id: ['not_allowed'] });
      const currency = await this.validate(tx, next, existing);
      const row = await tx.financeTransaction.update({
        where: { id },
        data: {
          ...(dto.amount === undefined ? {} : { amount: dto.amount }),
          accountId: next.accountId,
          toAccountId: next.toAccountId,
          categoryId: next.categoryId,
          currency,
          ...(dto.occurred_at === undefined ? {} : { occurredAt: new Date(dto.occurred_at) }),
          ...(dto.merchant === undefined ? {} : { merchant: dto.merchant || null }),
          ...(dto.notes === undefined ? {} : { notes: dto.notes || null }),
        },
        include: TRANSACTION_INCLUDE,
      });
      return transactionPayload(row);
    });
  }

  async removeTransaction(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const deleted = await tx.financeTransaction.deleteMany({ where: { id } });
      if (deleted.count === 0) throw notFound();
    });
  }

  // ---- Dashboard ---------------------------------------------------------

  async summary(ctx: AuthContext, query: SummaryQueryDto, locale: Locale): Promise<SummaryPayload> {
    return this.tenant(ctx, async (tx) => {
      await this.ensureDefaults(tx, ctx, locale);
      const company = await tx.company.findUniqueOrThrow({
        where: { id: ctx.companyId },
        select: { currency: true, timezone: true },
      });
      const range = periodRange(query.period ?? 'month', new Date(), company.timezone, {
        from: query.from,
        to: query.to,
      });
      if (range === null) throw fieldError({ from: ['invalid'] });
      const currency = company.currency;

      const totals = await tx.$queryRaw<{ type: string; total: string }[]>`
        SELECT type::text AS type, SUM(amount)::text AS total
          FROM finance_transactions
         WHERE occurred_at >= ${range.from} AND occurred_at < ${range.to}
           AND type <> 'transfer' AND currency = ${currency}
         GROUP BY type`;
      const income = money(totals.find((t) => t.type === 'income')?.total ?? '0');
      const expense = money(totals.find((t) => t.type === 'expense')?.total ?? '0');

      const byCategory = await tx.$queryRaw<
        { category_id: string | null; key: string | null; name: string | null; total: string }[]
      >`
        SELECT top.id AS category_id, top.key, top.name, SUM(t.amount)::text AS total
          FROM finance_transactions t
          LEFT JOIN finance_categories c ON c.id = t.category_id
          LEFT JOIN finance_categories top ON top.id = COALESCE(c.parent_id, c.id)
         WHERE t.occurred_at >= ${range.from} AND t.occurred_at < ${range.to}
           AND t.type = 'expense' AND t.currency = ${currency}
         GROUP BY top.id, top.key, top.name
         ORDER BY SUM(t.amount) DESC`;

      const others = await tx.financeTransaction.count({
        where: {
          occurredAt: { gte: range.from, lt: range.to },
          type: { not: 'transfer' },
          currency: { not: currency },
        },
      });

      const accounts = await this.accountRows(tx);
      const available = new Map<string, Decimal>();
      const owed = new Map<string, Decimal>();
      for (const account of accounts) {
        if (account.archived) continue;
        const balance = money(account.balance);
        if (account.type === 'credit_card') {
          if (balance.isNegative())
            owed.set(
              account.currency,
              (owed.get(account.currency) ?? Decimal.zero(MONEY)).add(balance.negate()),
            );
        } else {
          available.set(
            account.currency,
            (available.get(account.currency) ?? Decimal.zero(MONEY)).add(balance),
          );
        }
      }
      const entries = (map: Map<string, Decimal>) =>
        [...map.entries()]
          .sort(([a], [b]) => (a === currency ? -1 : b === currency ? 1 : a.localeCompare(b)))
          .map(([code, amount]) => ({ currency: code, amount: amount.toString() }));

      const recent = await tx.financeTransaction.findMany({
        include: TRANSACTION_INCLUDE,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        take: 8,
      });

      return {
        currency,
        period: { from: range.firstDay, to: range.lastDay },
        available: entries(available),
        credit_owed: entries(owed),
        income: income.toString(),
        expense: expense.toString(),
        net: income.subtract(expense).toString(),
        by_category: byCategory.map((row) => ({
          category_id: row.category_id,
          key: row.key,
          name: row.name,
          amount: money(row.total).toString(),
        })),
        accounts,
        recent: recent.map(transactionPayload),
        other_currencies: others > 0,
      };
    });
  }
}
