/**
 * 1to1OS Personal — budgets (Expenses phase 3).
 *
 * A budget stores its limit and rules; what was spent is summed from the
 * expense transactions on every read — in the budget's currency, in its
 * category and that category's subcategories (or all expenses for an overall
 * budget), between the period's first and last day in the account's time
 * zone. Transfers are never spending.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';
import { Decimal } from '@ufuq/money';

import { calendarDateIn, instantAt, parseCalendarDate } from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { fieldError, notFound, TenantScopedService } from '../company-structure/tenant-scoped.service.js';

import {
  addMonths,
  budgetStatus,
  compareMonths,
  DEFAULT_ALERTS,
  formatMonth,
  monthlyResults,
  monthsBetween,
  normaliseThresholds,
  parseMonth,
} from './budget-rules.js';
import type { BudgetStatus, Month } from './budget-rules.js';
import type { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto.js';

const SCALE = 2;

export interface BudgetPeriodPayload extends BudgetStatus {
  /** `YYYY-MM` for a monthly budget's month; null for a custom period. */
  readonly month: string | null;
  readonly from: string;
  readonly to: string;
  readonly limit: string;
  readonly carried: string;
  readonly spent: string;
  readonly remaining: string;
}

export interface BudgetPayload {
  readonly id: string;
  readonly name: string | null;
  readonly category_id: string | null;
  readonly category_key: string | null;
  readonly category_name: string | null;
  readonly period: 'monthly' | 'custom';
  readonly amount: string;
  readonly currency: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly rollover: boolean;
  readonly alert_thresholds: readonly number[];
  readonly archived: boolean;
  /** The measured period (the requested month, or the custom range); null when it is not running then. */
  readonly current: BudgetPeriodPayload | null;
}

export interface BudgetListPayload {
  readonly month: string;
  readonly currency: string;
  readonly budgets: readonly BudgetPayload[];
}

interface BudgetRow {
  readonly id: string;
  readonly name: string | null;
  readonly categoryId: string | null;
  readonly period: 'monthly' | 'custom';
  readonly amount: { toString(): string };
  readonly currency: string;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly rollover: boolean;
  readonly alertThresholds: number[];
  readonly archivedAt: Date | null;
  readonly category: { key: string | null; name: string | null } | null;
}

const BUDGET_INCLUDE = { category: { select: { key: true, name: true } } } as const;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function monthOf(date: Date): Month {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function lastDayOf(m: Month): string {
  const next = addMonths(m, 1);
  const last = new Date(Date.UTC(next.year, next.month - 1, 1) - 86_400_000);
  return day(last);
}

function toCalendar(value: string): CalendarDate {
  const parsed = parseCalendarDate(value);
  if (!parsed) throw fieldError({ start_date: ['invalid'] });
  return parsed;
}

function nextDay(value: string): CalendarDate {
  const d = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)) + 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

@Injectable()
export class PersonalBudgetsService extends TenantScopedService {
  constructor(@Inject(PRISMA_CLIENT) prisma: PrismaClient) {
    super(prisma);
  }

  // ---- Reading -------------------------------------------------------------

  async list(
    ctx: AuthContext,
    monthText: string | undefined,
    includeArchived: boolean,
  ): Promise<BudgetListPayload> {
    return this.tenant(ctx, async (tx) => {
      const company = await this.company(tx, ctx);
      const month = (monthText ? parseMonth(monthText) : null) ?? this.thisMonth(company.timezone);
      const rows = await tx.financeBudget.findMany({
        where: includeArchived ? {} : { archivedAt: null },
        include: BUDGET_INCLUDE,
        orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
      });
      const budgets: BudgetPayload[] = [];
      for (const row of rows) {
        budgets.push(await this.payload(tx, row, month, company.timezone));
      }
      // Most-used first, so what needs attention leads.
      budgets.sort((a, b) => (b.current?.percent ?? -1) - (a.current?.percent ?? -1));
      return { month: formatMonth(month), currency: company.currency, budgets };
    });
  }

  async get(ctx: AuthContext, id: string, monthText?: string): Promise<BudgetPayload> {
    return this.tenant(ctx, async (tx) => {
      const company = await this.company(tx, ctx);
      const row = await tx.financeBudget.findUnique({ where: { id }, include: BUDGET_INCLUDE });
      if (!row) throw notFound();
      const month = (monthText ? parseMonth(monthText) : null) ?? this.thisMonth(company.timezone);
      return this.payload(tx, row, month, company.timezone);
    });
  }

  /** A monthly budget's months so far (newest first); a custom budget's one period. */
  async history(ctx: AuthContext, id: string): Promise<BudgetPeriodPayload[]> {
    return this.tenant(ctx, async (tx) => {
      const company = await this.company(tx, ctx);
      const row = await tx.financeBudget.findUnique({ where: { id }, include: BUDGET_INCLUDE });
      if (!row) throw notFound();
      if (row.period === 'custom') {
        const current = await this.customPeriod(tx, row, company.timezone);
        return [current];
      }
      const results = await this.monthlyRun(tx, row, this.thisMonth(company.timezone), company.timezone);
      return results.reverse();
    });
  }

  // ---- Writing -------------------------------------------------------------

  async create(ctx: AuthContext, dto: CreateBudgetDto): Promise<BudgetPayload> {
    return this.tenant(ctx, async (tx) => {
      const company = await this.company(tx, ctx);
      const categoryId = dto.category_id ?? null;
      await this.checkCategory(tx, categoryId);
      const currency = dto.currency ?? company.currency;
      let startDate: string;
      let endDate: string | null = null;
      if (dto.period === 'monthly') {
        const start = (dto.start_month ? parseMonth(dto.start_month) : null) ?? this.thisMonth(company.timezone);
        startDate = `${formatMonth(start)}-01`;
        await this.checkDuplicate(tx, categoryId, currency, null);
      } else {
        if (!dto.start_date) throw fieldError({ start_date: ['required'] });
        if (!dto.end_date) throw fieldError({ end_date: ['required'] });
        if (dto.end_date < dto.start_date) throw fieldError({ end_date: ['invalid'] });
        startDate = dto.start_date;
        endDate = dto.end_date;
      }
      const row = await tx.financeBudget.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          userId: ctx.userId,
          name: dto.name || null,
          categoryId,
          period: dto.period,
          amount: dto.amount,
          currency,
          startDate: dateOnly(startDate),
          endDate: endDate === null ? null : dateOnly(endDate),
          rollover: dto.period === 'monthly' ? (dto.rollover ?? false) : false,
          alertThresholds: normaliseThresholds(dto.alert_thresholds ?? [...DEFAULT_ALERTS]),
        },
        include: BUDGET_INCLUDE,
      });
      return this.payload(tx, row, this.thisMonth(company.timezone), company.timezone);
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateBudgetDto): Promise<BudgetPayload> {
    return this.tenant(ctx, async (tx) => {
      const company = await this.company(tx, ctx);
      const existing = await tx.financeBudget.findUnique({ where: { id } });
      if (!existing) throw notFound();
      const custom = existing.period === 'custom';
      if (!custom && (dto.start_date !== undefined || dto.end_date !== undefined)) {
        throw fieldError({ start_date: ['not_allowed'] });
      }
      if (custom && dto.rollover === true) throw fieldError({ rollover: ['not_allowed'] });
      const start = dto.start_date ?? day(existing.startDate);
      const end = dto.end_date ?? (existing.endDate ? day(existing.endDate) : null);
      if (custom && end !== null && end < start) throw fieldError({ end_date: ['invalid'] });
      const row = await tx.financeBudget.update({
        where: { id },
        data: {
          ...(dto.name === undefined ? {} : { name: dto.name || null }),
          ...(dto.amount === undefined ? {} : { amount: dto.amount }),
          ...(custom && dto.start_date !== undefined ? { startDate: dateOnly(dto.start_date) } : {}),
          ...(custom && dto.end_date !== undefined ? { endDate: dateOnly(dto.end_date) } : {}),
          ...(!custom && dto.rollover !== undefined ? { rollover: dto.rollover } : {}),
          ...(dto.alert_thresholds === undefined
            ? {}
            : { alertThresholds: normaliseThresholds(dto.alert_thresholds) }),
        },
        include: BUDGET_INCLUDE,
      });
      return this.payload(tx, row, this.thisMonth(company.timezone), company.timezone);
    });
  }

  /** Archived, not lost: its history stays computable and it can be restored. */
  async archive(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const updated = await tx.financeBudget.updateMany({
        where: { id, archivedAt: null },
        data: { archivedAt: new Date() },
      });
      if (updated.count === 0 && !(await tx.financeBudget.findUnique({ where: { id }, select: { id: true } }))) {
        throw notFound();
      }
    });
  }

  async restore(ctx: AuthContext, id: string): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await tx.financeBudget.findUnique({ where: { id } });
      if (!row) throw notFound();
      if (row.archivedAt === null) return;
      if (row.period === 'monthly') await this.checkDuplicate(tx, row.categoryId, row.currency, row.id);
      await tx.financeBudget.update({ where: { id }, data: { archivedAt: null } });
    });
  }

  // ---- Internals -----------------------------------------------------------

  private async company(tx: TenantClient, ctx: AuthContext): Promise<{ currency: string; timezone: string }> {
    return tx.company.findUniqueOrThrow({
      where: { id: ctx.companyId },
      select: { currency: true, timezone: true },
    });
  }

  private thisMonth(timeZone: string): Month {
    const today = calendarDateIn(new Date(), timeZone);
    return { year: today.year, month: today.month };
  }

  private async checkCategory(tx: TenantClient, categoryId: string | null): Promise<void> {
    if (categoryId === null) return;
    const category = await tx.financeCategory.findUnique({ where: { id: categoryId } });
    if (!category || category.archivedAt !== null || category.kind !== 'expense') {
      throw fieldError({ category_id: ['invalid'] });
    }
  }

  /** One running monthly budget per category (or overall) and currency. */
  private async checkDuplicate(
    tx: TenantClient,
    categoryId: string | null,
    currency: string,
    except: string | null,
  ): Promise<void> {
    const clash = await tx.financeBudget.findFirst({
      where: {
        period: 'monthly',
        archivedAt: null,
        categoryId,
        currency,
        ...(except === null ? {} : { id: { not: except } }),
      },
      select: { id: true },
    });
    if (clash) throw fieldError({ category_id: ['already_taken'] });
  }

  /** Expenses in the budget's scope between two days (inclusive), in the zone. */
  private async spent(
    tx: TenantClient,
    row: BudgetRow,
    firstDay: string,
    lastDay: string,
    timeZone: string,
  ): Promise<string> {
    const from = instantAt(toCalendar(firstDay), 0, timeZone);
    const to = instantAt(nextDay(lastDay), 0, timeZone);
    const result = await tx.financeTransaction.aggregate({
      _sum: { amount: true },
      where: {
        type: 'expense',
        currency: row.currency,
        occurredAt: { gte: from, lt: to },
        ...(row.categoryId === null
          ? {}
          : { OR: [{ categoryId: row.categoryId }, { category: { parentId: row.categoryId } }] }),
      },
    });
    return Decimal.parse(result._sum.amount?.toString() ?? '0', SCALE).toString();
  }

  private async monthlyRun(
    tx: TenantClient,
    row: BudgetRow,
    until: Month,
    timeZone: string,
  ): Promise<BudgetPeriodPayload[]> {
    const months = monthsBetween(monthOf(row.startDate), until);
    const spent: { month: string; spent: string }[] = [];
    for (const m of months) {
      spent.push({
        month: formatMonth(m),
        spent: await this.spent(tx, row, `${formatMonth(m)}-01`, lastDayOf(m), timeZone),
      });
    }
    return monthlyResults(row.amount.toString(), spent, row.rollover).map((result, index) => {
      const m = months[index] ?? until;
      return {
        ...result,
        ...budgetStatus(result.spent, result.limit, row.alertThresholds),
        from: `${formatMonth(m)}-01`,
        to: lastDayOf(m),
      };
    });
  }

  private async customPeriod(tx: TenantClient, row: BudgetRow, timeZone: string): Promise<BudgetPeriodPayload> {
    const from = day(row.startDate);
    const to = row.endDate ? day(row.endDate) : from;
    const spent = await this.spent(tx, row, from, to, timeZone);
    const limit = Decimal.parse(row.amount.toString(), SCALE);
    return {
      month: null,
      from,
      to,
      limit: limit.toString(),
      carried: '0.00',
      spent,
      remaining: limit.subtract(Decimal.parse(spent, SCALE)).toString(),
      ...budgetStatus(spent, limit.toString(), row.alertThresholds),
    };
  }

  private async payload(tx: TenantClient, row: BudgetRow, month: Month, timeZone: string): Promise<BudgetPayload> {
    let current: BudgetPeriodPayload | null = null;
    if (row.period === 'monthly') {
      if (compareMonths(month, monthOf(row.startDate)) >= 0) {
        const run = await this.monthlyRun(tx, row, month, timeZone);
        current = run[run.length - 1] ?? null;
        if (current) current = { ...current, month: formatMonth(month) };
      }
    } else {
      const first = `${formatMonth(month)}-01`;
      const last = lastDayOf(month);
      const start = day(row.startDate);
      const end = row.endDate ? day(row.endDate) : start;
      // A custom budget shows in every month it overlaps, measured over its whole range.
      if (start <= last && end >= first) current = await this.customPeriod(tx, row, timeZone);
    }
    return {
      id: row.id,
      name: row.name,
      category_id: row.categoryId,
      category_key: row.category?.key ?? null,
      category_name: row.category?.name ?? null,
      period: row.period,
      amount: Decimal.parse(row.amount.toString(), SCALE).toString(),
      currency: row.currency,
      start_date: day(row.startDate),
      end_date: row.endDate ? day(row.endDate) : null,
      rollover: row.rollover,
      alert_thresholds: row.alertThresholds,
      archived: row.archivedAt !== null,
      current,
    };
  }
}
