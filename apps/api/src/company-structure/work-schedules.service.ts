/**
 * `/work-schedules` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.7–3.8, DOCUMENT 12.
 *
 * DOCUMENT 27 RULE 12 in one file: this is where a company's working week is
 * defined, and it is the *only* place in the system that knows one. Nothing
 * here supplies a default week, a default start time, or a default grace
 * period. A schedule that does not describe all seven days is refused rather
 * than completed with an assumption — DOCUMENT 12 business rule 3, "working
 * days come from the schedule, never from code".
 *
 * Every write is audited as DOCUMENT 21 `settings.schedule_changed`.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';

import type { ResolvedPage } from './dto/pagination.dto.js';
import type {
  CreateWorkScheduleDto,
  UpdateWorkScheduleDto,
  WorkScheduleDayDto,
} from './dto/work-schedule.dto.js';
import { DAYS_IN_WEEK } from './dto/work-schedule.dto.js';
import { workSchedulePayload } from './payloads.js';
import type { WorkSchedulePayload } from './payloads.js';
import { fieldError, notFound, TenantScopedService } from './tenant-scoped.service.js';
import { parseTimeOfDay } from './validation.js';

export interface WorkScheduleList {
  readonly items: readonly WorkSchedulePayload[];
  readonly total: number;
}

/** Days always come back in weekday order — a schedule is read as a week. */
const DAYS_INCLUDE = {
  days: { orderBy: { dayOfWeek: 'asc' } },
} as const satisfies Prisma.WorkScheduleInclude;

@Injectable()
export class WorkSchedulesService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  async list(ctx: AuthContext, page: ResolvedPage): Promise<WorkScheduleList> {
    return this.tenant(ctx, async (tx) => {
      const where: Prisma.WorkScheduleWhereInput = { deletedAt: null };
      const [rows, total] = await Promise.all([
        tx.workSchedule.findMany({
          where,
          include: DAYS_INCLUDE,
          // The default first: it is the one a reader is looking for.
          orderBy: [{ isDefault: 'desc' }, { name: 'asc' }, { id: 'asc' }],
          skip: page.skip,
          take: page.take,
        }),
        tx.workSchedule.count({ where }),
      ]);
      return { items: rows.map(workSchedulePayload), total };
    });
  }

  async create(
    ctx: AuthContext,
    dto: CreateWorkScheduleDto,
    origin: RequestOrigin,
  ): Promise<WorkSchedulePayload> {
    const days = validateWeek(dto.days);

    return this.tenant(ctx, async (tx) => {
      const isDefault = dto.is_default ?? false;
      if (isDefault) {
        await this.clearDefault(tx, null);
      }

      const row = await tx.workSchedule.create({
        data: {
          id: generateId(),
          companyId: ctx.companyId,
          name: dto.name,
          isDefault,
          timezone: dto.timezone,
          gracePeriodMinutes: dto.grace_period_minutes,
          halfDayThresholdHours: dto.half_day_threshold_hours,
          overtimePolicy: dto.overtime_policy,
          breakMinutes: dto.break_minutes,
          days: { create: days.map(toDayRow) },
        },
        include: DAYS_INCLUDE,
      });

      const payload = workSchedulePayload(row);
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SETTINGS_SCHEDULE_CHANGED',
        entityType: 'work_schedule',
        entityId: row.id,
        // A creation has no previous state; `new_values` alone is the whole
        // change (DOCUMENT 21 "Record content" — only what changed).
        newValues: payload as unknown as Prisma.InputJsonObject,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      return payload;
    });
  }

  async update(
    ctx: AuthContext,
    id: string,
    dto: UpdateWorkScheduleDto,
    origin: RequestOrigin,
  ): Promise<WorkSchedulePayload> {
    const days = dto.days === undefined ? null : validateWeek(dto.days);

    return this.tenant(ctx, async (tx) => {
      const existing = await tx.workSchedule.findFirst({
        where: { id, deletedAt: null },
        include: DAYS_INCLUDE,
      });
      if (!existing) {
        throw notFound();
      }
      const before = workSchedulePayload(existing);

      const data: Prisma.WorkScheduleUpdateInput = {};
      if (dto.name !== undefined) {
        data.name = dto.name;
      }
      if (dto.timezone !== undefined) {
        data.timezone = dto.timezone;
      }
      if (dto.grace_period_minutes !== undefined) {
        data.gracePeriodMinutes = dto.grace_period_minutes;
      }
      if (dto.half_day_threshold_hours !== undefined) {
        data.halfDayThresholdHours = dto.half_day_threshold_hours;
      }
      if (dto.overtime_policy !== undefined) {
        data.overtimePolicy = dto.overtime_policy;
      }
      if (dto.break_minutes !== undefined) {
        data.breakMinutes = dto.break_minutes;
      }

      if (dto.is_default !== undefined) {
        if (dto.is_default) {
          await this.clearDefault(tx, existing.id);
        }
        // Turning the flag *off* is allowed and leaves the company with no
        // default. That is a state an admin can reach deliberately, and
        // inventing a rule that forbids it — or silently promoting another
        // schedule — would be a workflow no document describes.
        data.isDefault = dto.is_default;
      }

      // The week is replaced wholesale, inside the same transaction as the
      // rest of the change: a schedule half-way between two weeks is not a
      // state anything downstream should ever be able to read.
      if (days !== null) {
        await tx.workScheduleDay.deleteMany({ where: { workScheduleId: existing.id } });
        await tx.workScheduleDay.createMany({
          data: days.map((day) => ({ ...toDayRow(day), workScheduleId: existing.id })),
        });
      }

      const row = await tx.workSchedule.update({
        where: { id: existing.id },
        data,
        include: DAYS_INCLUDE,
      });
      const after = workSchedulePayload(row);

      const { oldValues, newValues } = diff(before, after);
      if (Object.keys(newValues).length > 0) {
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'SETTINGS_SCHEDULE_CHANGED',
          entityType: 'work_schedule',
          entityId: row.id,
          oldValues: oldValues as Prisma.InputJsonObject,
          newValues: newValues as Prisma.InputJsonObject,
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }

      return after;
    });
  }

  /**
   * "Default" is singular. This clears the current holder before the new one
   * is written; the partial unique index in the migration is what makes two
   * concurrent requests fail rather than race past each other.
   */
  private async clearDefault(tx: TenantClient, exceptId: string | null): Promise<void> {
    await tx.workSchedule.updateMany({
      where: {
        isDefault: true,
        deletedAt: null,
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      data: { isDefault: false },
    });
  }
}

function toDayRow(day: WorkScheduleDayDto): {
  id: string;
  dayOfWeek: number;
  isWorkingDay: boolean;
  startTime: Date | null;
  endTime: Date | null;
} {
  return {
    id: generateId(),
    dayOfWeek: day.day_of_week,
    isWorkingDay: day.is_working_day,
    startTime: day.is_working_day ? parseTimeOfDay(day.start_time as string) : null,
    endTime: day.is_working_day ? parseTimeOfDay(day.end_time as string) : null,
  };
}

/**
 * All seven weekdays, each exactly once, each internally consistent.
 *
 * Pure and exported so it can be tested directly: this is the rule that keeps
 * a working week from being half-defined, and it is worth being able to state
 * every way it fails without booting an HTTP server to do it.
 */
export function validateWeek(days: readonly WorkScheduleDayDto[]): readonly WorkScheduleDayDto[] {
  const seen = new Set<number>();
  for (const day of days) {
    if (seen.has(day.day_of_week)) {
      throw fieldError({ days: ['incomplete_week'] });
    }
    seen.add(day.day_of_week);
  }
  if (seen.size !== DAYS_IN_WEEK) {
    throw fieldError({ days: ['incomplete_week'] });
  }

  for (const day of days) {
    const index = day.day_of_week;
    if (day.is_working_day) {
      const start = day.start_time ?? null;
      const end = day.end_time ?? null;
      if (start === null || end === null) {
        throw fieldError({ [`days.${String(index)}`]: ['required'] });
      }
      // String comparison is exact for zero-padded `HH:MM`, and avoids
      // inventing a second notion of "time" alongside the column's.
      if (end <= start) {
        throw fieldError({ [`days.${String(index)}`]: ['end_before_start'] });
      }
    } else if ((day.start_time ?? null) !== null || (day.end_time ?? null) !== null) {
      // A non-working day carrying hours is ambiguous rather than harmless:
      // a later phase reading it cannot tell whether the day was meant to be
      // worked. The database refuses it too — see the CHECK constraint.
      throw fieldError({ [`days.${String(index)}`]: ['invalid'] });
    }
  }

  return days;
}

/** The changed keys of a schedule payload, for the audit record. */
function diff(
  before: WorkSchedulePayload,
  after: WorkSchedulePayload,
): { oldValues: Record<string, unknown>; newValues: Record<string, unknown> } {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof WorkSchedulePayload)[]) {
    if (key === 'updated_at') {
      continue;
    }
    const previous = before[key];
    const current = after[key];
    // `days` is an array; JSON is the cheap structural comparison, and it is
    // also the form the audit record stores it in.
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      oldValues[key] = previous;
      newValues[key] = current;
    }
  }
  return { oldValues, newValues };
}
