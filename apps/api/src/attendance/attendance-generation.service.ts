/**
 * Generated attendance — DOCUMENT 12 rules 9 and 10, and the "employee forgets
 * to check out" edge case.
 *
 * Three jobs, all idempotent, all writing `source = system`:
 *
 *   1. **Weekend and holiday records** (rule 9) so a month is complete. A
 *      monthly view or a payroll run that has to infer "no row means rest day"
 *      is a view that cannot tell a rest day from a day nobody recorded.
 *   2. **Absence** (rule 10): a working day that ended with no record and no
 *      approved leave becomes `absent`.
 *   3. **Closing a forgotten record**: checked in, never checked out — closed
 *      at the schedule's end time and left `pending`, which is the state the
 *      employee is asked to correct.
 *   4. **A day cancelled leave handed back** (Phase 10 corrective pass): a
 *      system `pending` row with no check-in and no leave, once its day has
 *      ended, becomes what job 2 would have written: `absent`, or the
 *      calendar's `holiday` / `weekend`.
 *
 * **Idempotent** is the property that matters, because a nightly job that runs
 * twice, or is re-run by hand after a failure, must not double-write or
 * overwrite a real day. Every write here is conditional on the day not already
 * having a record, except the close, which is conditional on the record being
 * open, and job 4, which is conditional on that exact never-worked shape. Nothing generated ever replaces something an employee or an admin
 * recorded.
 *
 * DOCUMENT 12's mid-month joiners and leavers fall out of the employee query:
 * a day before `joining_date` or after `termination_date` is not generated at
 * all, so it is absent from the month rather than counted against anybody.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { generateId, listActiveCompanyIds, withPlatformContext, withTenant } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';

import { calculateDay, scheduledEndInstant } from './calculation.js';
import type { ScheduleDay, ScheduleSettings } from './calculation.js';
import { dateValue } from './attendance-query.js';
import { attendanceAuditSnapshot } from './attendance-payload.js';
import {
  dayFor,
  isHolidayOn,
  loadScheduleContext,
  ScheduleIncompleteError,
} from './schedule-context.js';
import {
  SYSTEM_ACTOR_ROLE_KEY,
  SystemActorService,
  SystemActorUnavailableError,
} from './system-actor.service.js';
import {
  calendarDateIn,
  compareDates,
  eachDay,
  formatCalendarDate,
  parseCalendarDate,
} from './zoned-time.js';
import type { CalendarDate } from './zoned-time.js';

export interface GenerationResult {
  readonly generated: number;
  readonly closed: number;
  /** Employees skipped because their schedule is incomplete (DOCUMENT 27 RULE 12). */
  readonly skipped: readonly string[];
}

interface EmployeeForGeneration {
  readonly id: string;
  readonly workScheduleId: string;
  readonly joiningDate: Date;
  readonly terminationDate: Date | null;
}

@Injectable()
export class AttendanceGenerationService {
  private readonly logger = new Logger(AttendanceGenerationService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
    @Inject(SystemActorService) private readonly systemActor: SystemActorService,
  ) {}

  /**
   * Fill a date range for one company.
   *
   * The acting user is **not** a parameter. DOCUMENT 21 requires an actor on
   * every audit record and forbids null, and the only correct actor for a row
   * the system generated is that company's designated system actor — so it is
   * resolved here rather than accepted from a caller who could pass anybody.
   */
  async generateRange(
    companyId: string,
    from: CalendarDate,
    to: CalendarDate,
    now: Date = new Date(),
  ): Promise<GenerationResult> {
    return this.audit.withTenant(companyId, async (tx) => {
      const systemUserId = await this.systemActor.resolve(tx, companyId);
      const employees = await tx.employee.findMany({
        // A terminated employee's days are still generated up to their
        // termination date, which is why status is not filtered here — the
        // per-day window below is what excludes them.
        where: { deletedAt: null },
        select: { id: true, workScheduleId: true, joiningDate: true, terminationDate: true },
      });

      let generated = 0;
      let closed = 0;
      const skipped: string[] = [];

      for (const employee of employees) {
        try {
          const result = await this.generateForEmployee(
            tx,
            companyId,
            employee,
            from,
            to,
            systemUserId,
            now,
          );
          generated += result.generated;
          closed += result.closed;
        } catch (error) {
          if (error instanceof ScheduleIncompleteError) {
            // DOCUMENT 27 RULE 12: a missing weekday row is a configuration
            // fault. Skipping this employee and naming them is honest;
            // assuming a working day would quietly invent the week.
            this.logger.error(
              `Attendance generation skipped employee ${employee.id}: ${error.message}`,
            );
            skipped.push(employee.id);
            continue;
          }
          throw error;
        }
      }

      return { generated, closed, skipped };
    });
  }

  private async generateForEmployee(
    tx: TenantClient,
    companyId: string,
    employee: EmployeeForGeneration,
    from: CalendarDate,
    to: CalendarDate,
    systemUserId: string,
    now: Date,
  ): Promise<{ generated: number; closed: number }> {
    const context = await loadScheduleContext(tx, employee.workScheduleId, from, to);
    const joining = calendarDateIn(employee.joiningDate, 'UTC');
    const termination =
      employee.terminationDate === null ? null : calendarDateIn(employee.terminationDate, 'UTC');

    const existing = await tx.attendanceRecord.findMany({
      where: { employeeId: employee.id, date: { gte: dateValue(from), lte: dateValue(to) } },
      select: {
        id: true,
        date: true,
        checkInAt: true,
        checkOutAt: true,
        status: true,
        workMode: true,
        workingMinutes: true,
        overtimeMinutes: true,
        lateMinutes: true,
        source: true,
        note: true,
        leaveRequestId: true,
      },
    });
    const byDate = new Map(existing.map((row) => [row.date.toISOString().slice(0, 10), row]));

    let generated = 0;
    let closed = 0;

    for (const date of eachDay(from, to)) {
      // DOCUMENT 12: "employee joins mid-month" / "terminated mid-month" —
      // days outside employment are not this employee's days at all.
      if (compareDates(date, joining) < 0) continue;
      if (termination !== null && compareDates(date, termination) > 0) continue;

      const day = dayFor(context, date, employee.workScheduleId);
      const holiday = isHolidayOn(context, date);
      const key = formatCalendarDate(date);
      const record = byDate.get(key);

      if (record !== undefined) {
        // An open record on a day that has finished is the forgotten
        // check-out. Closed at the scheduled end, left `pending`.
        if (record.checkInAt !== null && record.checkOutAt === null) {
          const end = scheduledEndInstant(date, day, context.settings);
          if (end !== null && end.getTime() <= now.getTime()) {
            const before = attendanceAuditSnapshot(record);
            const updated = await tx.attendanceRecord.update({
              where: { id: record.id },
              data: {
                checkOutAt: end,
                // Deliberately left `pending` rather than calculated: the
                // employee did not say when they left, so the minutes are a
                // guess until a correction replaces them.
                status: 'pending',
                workingMinutes: null,
                overtimeMinutes: null,
              },
            });
            await this.audit.record(tx, {
              companyId,
              userId: systemUserId,
              action: 'ATTENDANCE_GENERATED_BY_SYSTEM',
              entityType: 'attendance_record',
              entityId: record.id,
              oldValues: before,
              newValues: attendanceAuditSnapshot(updated),
            });
            closed += 1;
          }
        }
        // A day cancelled leave handed back before it happened: reconciled
        // to `pending` with no check-in (`dayWithoutLeave`). Once it has
        // ended with still no check-in, it is what any unrecorded working day
        // becomes. Only that exact shape is touched: system-written, never
        // checked in, not linked to leave.
        if (
          record.status === 'pending' &&
          record.source === 'system' &&
          record.checkInAt === null &&
          record.leaveRequestId === null &&
          this.dayHasEnded(date, day, context.settings, now)
        ) {
          const before = attendanceAuditSnapshot(record);
          const calculated = calculateDay({
            date,
            schedule: context.settings,
            day,
            checkInAt: null,
            checkOutAt: null,
            isHoliday: holiday,
          });
          const updated = await tx.attendanceRecord.update({
            where: { id: record.id },
            data: {
              status: calculated.status as never,
              workingMinutes: calculated.workingMinutes,
              overtimeMinutes: calculated.overtimeMinutes,
              lateMinutes: calculated.lateMinutes,
            },
          });
          await this.audit.record(tx, {
            companyId,
            userId: systemUserId,
            action: 'ATTENDANCE_GENERATED_BY_SYSTEM',
            entityType: 'attendance_record',
            entityId: record.id,
            oldValues: before,
            newValues: attendanceAuditSnapshot(updated),
          });
          generated += 1;
        }
        continue;
      }

      // A day that has not finished yet is not an absence — it is a day still
      // in progress, and writing `absent` onto it at noon would be wrong.
      if (!this.dayHasEnded(date, day, context.settings, now)) {
        continue;
      }

      const calculated = calculateDay({
        date,
        schedule: context.settings,
        day,
        checkInAt: null,
        checkOutAt: null,
        isHoliday: holiday,
      });

      const created = await tx.attendanceRecord.create({
        data: {
          id: generateId(),
          companyId,
          employeeId: employee.id,
          date: dateValue(date),
          workMode: null,
          checkInAt: null,
          checkOutAt: null,
          workingMinutes: calculated.workingMinutes,
          overtimeMinutes: calculated.overtimeMinutes,
          lateMinutes: calculated.lateMinutes,
          status: calculated.status as never,
          source: 'system',
          createdBy: null,
        },
      });
      await this.audit.record(tx, {
        companyId,
        userId: systemUserId,
        action: 'ATTENDANCE_GENERATED_BY_SYSTEM',
        entityType: 'attendance_record',
        entityId: created.id,
        newValues: attendanceAuditSnapshot(created),
      });
      generated += 1;
    }

    return { generated, closed };
  }

  /**
   * Whether a day is over, in the schedule's zone.
   *
   * A rest day or a holiday is over once the calendar day itself has passed;
   * a working day is over at its scheduled end. Without this, a job running
   * during the working day would mark everybody who has not yet arrived
   * absent.
   */
  private dayHasEnded(
    date: CalendarDate,
    day: ScheduleDay,
    settings: ScheduleSettings,
    now: Date,
  ): boolean {
    const end = scheduledEndInstant(date, day, settings);
    if (end !== null) {
      return end.getTime() <= now.getTime();
    }
    const today = calendarDateIn(now, settings.timezone);
    return compareDates(date, today) < 0;
  }

  /**
   * The nightly run — DOCUMENT 12 rule 10.
   *
   * Yesterday in each company's own zone, because "last night" is not the same
   * instant everywhere and a single UTC cutoff would run a day early for some
   * companies and a day late for others.
   *
   * **Which companies** is the one question asked outside a tenant. With no
   * `app.company_id` bound, row-level security shows `ufuq_app` no companies
   * at all, so a plain `company.findMany` here returns nothing and the run
   * silently generates nothing. The ids come from the platform lookup instead
   * (DOCUMENT 09 §7), and everything else — the timezone, the employees, the
   * writes — is read and written inside that company's own tenant scope.
   */
  async runNightly(now: Date = new Date()): Promise<Map<string, GenerationResult>> {
    const companyIds = await withPlatformContext(this.prisma, (tx) => listActiveCompanyIds(tx));

    const results = new Map<string, GenerationResult>();
    for (const companyId of companyIds) {
      const company = await withTenant(this.prisma, companyId, (tx) =>
        tx.company.findUnique({ where: { id: companyId }, select: { timezone: true } }),
      );
      if (company === null) continue;
      const today = calendarDateIn(now, company.timezone);
      const yesterday = previousDay(today);
      try {
        results.set(companyId, await this.generateRange(companyId, yesterday, yesterday, now));
      } catch (error) {
        if (error instanceof SystemActorUnavailableError) {
          // Refused rather than attributed to a real administrator: a wrong
          // actor on an audit record is worse than a run that says why it
          // stopped (DOCUMENT 21 "Record content").
          this.logger.warn(
            `Attendance generation skipped company ${companyId}: no system actor could be ` +
              `resolved (the '${SYSTEM_ACTOR_ROLE_KEY}' system role is not seeded).`,
          );
          continue;
        }
        throw error;
      }
    }
    return results;
  }
}

function previousDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) - 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Exposed for the admin generation endpoint's date parsing. */
export function monthRange(value: string): { from: CalendarDate; to: CalendarDate } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = parseCalendarDate(`${match[1]}-${match[2]}-01`);
  const to = parseCalendarDate(`${match[1]}-${match[2]}-${String(last).padStart(2, '0')}`);
  return from === null || to === null ? null : { from, to };
}
