/**
 * `/holidays` — DOCUMENT 08 §4.2, DOCUMENT 06 §3.9, DOCUMENT 12.
 *
 * A holiday is part of a company's schedule configuration: DOCUMENT 04 B25
 * puts holidays on the Schedules settings screen, and DOCUMENT 12's edge case
 * "holiday added retroactively" requires the change to be audited. So a
 * holiday write is recorded as DOCUMENT 21 `settings.schedule_changed`, the
 * enumerated action that covers schedule configuration.
 *
 * The rest of that edge case — "existing records are not silently rewritten;
 * the admin is shown which records would change and confirms explicitly" — is
 * about `attendance_records`, which Phase 6 creates. In Phase 4 there is
 * nothing for a new holiday to rewrite, so there is nothing to confirm; the
 * confirmation step belongs to the phase that gives it something to say.
 */

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { Prisma, PrismaClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';

import type { CreateHolidayDto } from './dto/holiday.dto.js';
import type { ResolvedPage } from './dto/pagination.dto.js';
import { holidayPayload } from './payloads.js';
import type { CreatedHolidayPayload, HolidayPayload } from './payloads.js';
import { fieldError, isUniqueViolation, TenantScopedService } from './tenant-scoped.service.js';
import { parseCalendarDate } from './validation.js';

export interface HolidayList {
  readonly items: readonly HolidayPayload[];
  readonly total: number;
}

@Injectable()
export class HolidaysService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
  }

  async list(ctx: AuthContext, page: ResolvedPage): Promise<HolidayList> {
    return this.tenant(ctx, async (tx) => {
      const [rows, total] = await Promise.all([
        // Chronological, and `(company_id, date)` is unique so it never ties.
        tx.holiday.findMany({ orderBy: { date: 'asc' }, skip: page.skip, take: page.take }),
        tx.holiday.count(),
      ]);
      return { items: rows.map(holidayPayload), total };
    });
  }

  async create(
    ctx: AuthContext,
    dto: CreateHolidayDto,
    origin: RequestOrigin,
  ): Promise<CreatedHolidayPayload> {
    // Already validated by `IsCalendarDate`; parsed here through the same
    // function so the validator and the write cannot disagree about what
    // "2026-02-29" means.
    const date = parseCalendarDate(dto.date);
    if (date === null) {
      throw fieldError({ date: ['invalid'] });
    }

    return this.tenant(ctx, async (tx) => {
      let row;
      try {
        row = await tx.holiday.create({
          data: {
            id: generateId(),
            companyId: ctx.companyId,
            date,
            nameAr: dto.name_ar,
            nameEn: dto.name_en,
            isRecurring: dto.is_recurring ?? false,
          },
        });
      } catch (error) {
        // `(company_id, date)` is unique — DOCUMENT 06 §3.9. One company, one
        // holiday per day.
        throw isUniqueViolation(error) ? fieldError({ date: ['already_taken'] }) : error;
      }

      const payload = holidayPayload(row);
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SETTINGS_SCHEDULE_CHANGED',
        entityType: 'holiday',
        entityId: row.id,
        newValues: payload as unknown as Prisma.InputJsonObject,
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });

      // Approved leave already holding this day stays exactly as approved.
      const leaveDays = await tx.attendanceRecord.findMany({
        where: { date, leaveRequestId: { not: null } },
        select: {
          leaveRequest: {
            select: {
              id: true,
              status: true,
              startDate: true,
              endDate: true,
              employee: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
      });
      const affected = leaveDays
        .map((day) => day.leaveRequest)
        .filter(
          (leave): leave is NonNullable<typeof leave> =>
            leave !== null && leave.status === 'approved',
        )
        .map((leave) => ({
          id: leave.id,
          employee_id: leave.employee.id,
          employee_name: `${leave.employee.firstName} ${leave.employee.lastName}`.trim(),
          start_date: leave.startDate.toISOString().slice(0, 10),
          end_date: leave.endDate.toISOString().slice(0, 10),
        }));

      return { ...payload, affected_leave_requests: affected };
    });
  }
}
