/**
 * Performance — DOCUMENT 14 "Performance", DOCUMENT 08 §4.2 and §4.3.
 *
 *   - `GET/PATCH /performance-config` — the company's model, validated by
 *     `performance-config.ts` and audited as
 *     `settings.performance_weights_changed` (DOCUMENT 21).
 *   - `GET /employees/{id}/performance?month=YYYY-MM` — one employee's
 *     scores for a month: this file gathers the counts DOCUMENT 14 names from
 *     attendance, tasks and goals, and hands them with the company's
 *     configuration to the engine (`performance-rules.ts`). It decides no
 *     number itself.
 *
 * What "the month" means for each component — the interpretations recorded
 * in docs/PHASE-8-STATUS.md:
 *
 *   - **Attendance** is measured over the scheduled working days of the month
 *     that have ended (up to yesterday, in the company's zone), within the
 *     employee's employment. Working days come from the employee's own
 *     schedule and the company's holidays — never a hardcoded week
 *     (DOCUMENT 27 RULE 12). Days are judged by the record the attendance
 *     engine wrote for them.
 *   - **Tasks** are the employee's uncancelled tasks due in the month (by
 *     deadline; a task with no deadline belongs to the month it was created
 *     in). On time means completed on or before the deadline's day.
 *   - **Goals** are the employee's uncancelled goals whose period overlaps
 *     the month, each at the value its history held at the month's end (or
 *     now, for the current month) — DOCUMENT 14 "Goal period spans two payroll
 *     months: … the progress snapshot at each month end".
 *
 * Scope (DOCUMENT 09 §4): another company's employee is a 404; an employee in
 * the tenant outside the caller's `report.employee_monthly` scope is a 403.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { dateValue as calendarDateValue } from '../attendance/attendance-query.js';
import {
  dayFor,
  isHolidayOn,
  loadScheduleContext,
  ScheduleIncompleteError,
} from '../attendance/schedule-context.js';
import {
  calendarDateIn,
  compareDates,
  eachDay,
  formatCalendarDate,
  instantAt,
  parseCalendarDate,
} from '../attendance/zoned-time.js';
import type { CalendarDate } from '../attendance/zoned-time.js';
import { AuditService } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { dateToWire } from '../attendance/attendance-payload.js';
import { employeeScopeWhere, forbidden } from '../employees/employee-query.js';
import { valueToWire } from '../goals/goal-payload.js';
import { effectiveTarget, progressPercent } from '../goals/goal-rules.js';
import type { GoalTypeValue } from '../goals/goal-rules.js';
import { personRef } from '../tasks/task-payload.js';
import type { PersonRef } from '../tasks/task-payload.js';

import type {
  EmployeePerformanceQueryDto,
  UpdatePerformanceConfigDto,
} from './dto/performance.dto.js';
import {
  flattenConfig,
  parsePerformanceConfig,
  PERFORMANCE_CONFIG_VERSION,
  performanceConfigToJson,
} from './performance-config.js';
import type { PerformanceConfig, PerformanceConfigJson } from './performance-config.js';
import { computePerformance } from './performance-rules.js';
import type { AttendanceInputs, TaskInputs } from './performance-rules.js';

export interface PerformanceConfigPayload extends PerformanceConfigJson {
  readonly schema_version: number;
  readonly updated_at: string;
  /** Null while the company still has the default the database wrote. */
  readonly updated_by: PersonRef | null;
}

/**
 * Why attendance has no score: the window held no scheduled working day; the
 * schedule cannot say which days are working days; or not one working day in
 * the window has a record — DOCUMENT 14 "Error states": a month with no data
 * is shown as "no data", never 0%.
 */
export type AttendanceNoDataReason = 'no_working_days' | 'schedule_incomplete' | 'no_records';

export interface EmployeePerformancePayload {
  readonly employee_id: string;
  readonly month: string;
  /** The month has not ended yet in the company's zone; the figures will move. */
  readonly is_provisional: boolean;
  /** The configuration these scores were computed with (DOCUMENT 14: explicable later). */
  readonly config: PerformanceConfigJson & { readonly schema_version: number };
  readonly components: {
    readonly attendance: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly no_data_reason: AttendanceNoDataReason | null;
      readonly inputs: {
        readonly from: string | null;
        readonly to: string | null;
        readonly working_days: number;
        readonly present_days: number;
        readonly wfh_days: number;
        readonly paid_leave_days: number;
        readonly late_incidents: number;
        readonly absent_days: number;
      } | null;
    };
    readonly task: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly completion_rate: string | null;
      readonly on_time_rate: string | null;
      readonly inputs: {
        readonly assigned: number;
        readonly completed: number;
        readonly completed_on_time: number;
      };
    };
    readonly goal: {
      readonly score: string | null;
      readonly weight: string;
      readonly effective_weight: string | null;
      readonly goals: readonly {
        readonly id: string;
        readonly title: string;
        readonly type: GoalTypeValue;
        readonly progress_percent: string;
      }[];
    };
  };
  /** Null is "no data" — never 0% (DOCUMENT 14 "Employees with no data"). */
  readonly overall: string | null;
}

const PERSON_SELECT = {
  id: true,
  email: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

/** Statuses of a day the employee attended (DOCUMENT 12 "Status values"). */
const ATTENDED = new Set(['present', 'late', 'half_day', 'pending']);

@Injectable()
export class PerformanceService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {
    super(prisma);
  }

  // -- Configuration — DOCUMENT 08 §4.2 -------------------------------------

  async getConfig(ctx: AuthContext): Promise<PerformanceConfigPayload> {
    return this.tenant(ctx, async (tx) => {
      const row = await this.loadConfigRow(tx);
      return configPayload(row, readConfig(row));
    });
  }

  async updateConfig(
    ctx: AuthContext,
    dto: UpdatePerformanceConfigDto,
    origin: RequestOrigin,
  ): Promise<PerformanceConfigPayload> {
    const parsed = parsePerformanceConfig({
      ...(dto.weights === undefined ? {} : { weights: dto.weights }),
      ...(dto.attendance === undefined ? {} : { attendance: dto.attendance }),
      ...(dto.task === undefined ? {} : { task: dto.task }),
    });
    if (!parsed.ok) {
      throw fieldError(parsed.fields);
    }
    const json = performanceConfigToJson(parsed.config);

    return this.tenant(ctx, async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM performance_config FOR UPDATE`;
      const before = await this.loadConfigRow(tx);
      const old = flattenConfig(performanceConfigToJson(readConfig(before)));
      const next = flattenConfig(json);

      const changedKeys = Object.keys(next).filter((key) => old[key] !== next[key]);
      if (changedKeys.length === 0) {
        return configPayload(before, parsed.config);
      }
      await tx.performanceConfig.update({
        where: { id: before.id },
        data: {
          schemaVersion: PERFORMANCE_CONFIG_VERSION,
          config: json as unknown as Prisma.InputJsonObject,
          updatedBy: ctx.userId,
        },
      });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'SETTINGS_PERFORMANCE_WEIGHTS_CHANGED',
        entityType: 'performance_config',
        entityId: before.id,
        oldValues: Object.fromEntries(changedKeys.map((key) => [key, old[key] ?? null])),
        newValues: Object.fromEntries(changedKeys.map((key) => [key, next[key] ?? null])),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
      const after = await this.loadConfigRow(tx);
      return configPayload(after, parsed.config);
    });
  }

  // -- One employee's month — DOCUMENT 08 §4.3 -------------------------------

  async employeePerformance(
    ctx: AuthContext,
    employeeId: string,
    query: EmployeePerformanceQueryDto,
    now = new Date(),
  ): Promise<EmployeePerformancePayload> {
    return this.tenant(ctx, async (tx) => {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, deletedAt: null },
        select: {
          id: true,
          workScheduleId: true,
          joiningDate: true,
          terminationDate: true,
        },
      });
      if (employee === null) {
        throw notFound();
      }
      const reachable = await tx.employee.findFirst({
        where: { AND: [{ id: employeeId }, employeeScopeWhere(ctx, 'report.employee_monthly')] },
        select: { id: true },
      });
      if (reachable === null) {
        throw forbidden();
      }

      const configRow = await this.loadConfigRow(tx);
      const config = readConfig(configRow);
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      const timeZone = company.timezone;
      const today = calendarDateIn(now, timeZone);
      const month = resolveMonth(query.month, today);

      const attendance = await this.attendanceInputs(tx, employee, month, today);
      const task = await this.taskInputs(tx, employee.id, month, timeZone);
      const goals = await this.goalInputs(tx, employee, month, timeZone);

      const result = computePerformance(
        {
          attendance: attendance.reason === null ? attendance.inputs : null,
          task,
          goalPercents: goals.map((goal) => goal.progress_percent),
        },
        config,
      );

      const json = performanceConfigToJson(config);
      return {
        employee_id: employee.id,
        month: month.key,
        is_provisional: compareDates(month.last, today) >= 0,
        config: { schema_version: configRow.schemaVersion, ...json },
        components: {
          attendance: {
            score: result.attendance.score,
            weight: json.weights.attendance,
            effective_weight: result.effectiveWeights.attendance,
            no_data_reason: attendance.reason,
            inputs:
              attendance.inputs === null
                ? null
                : {
                    from: attendance.from,
                    to: attendance.to,
                    working_days: attendance.inputs.workingDays,
                    present_days: attendance.inputs.presentDays,
                    wfh_days: attendance.inputs.wfhDays,
                    paid_leave_days: attendance.inputs.paidLeaveDays,
                    late_incidents: attendance.inputs.lateIncidents,
                    absent_days: attendance.inputs.absentDays,
                  },
          },
          task: {
            score: result.task.score,
            weight: json.weights.task,
            effective_weight: result.effectiveWeights.task,
            completion_rate: result.task.completionRate,
            on_time_rate: result.task.onTimeRate,
            inputs: {
              assigned: task.assigned,
              completed: task.completed,
              completed_on_time: task.completedOnTime,
            },
          },
          goal: {
            score: result.goal.score,
            weight: json.weights.goal,
            effective_weight: result.effectiveWeights.goal,
            goals,
          },
        },
        overall: result.overall,
      };
    });
  }

  // -- Internals ---------------------------------------------------------------

  private async loadConfigRow(tx: TenantClient) {
    const row = await tx.performanceConfig.findFirst({
      include: { updatedByUser: { select: PERSON_SELECT } },
    });
    if (row === null) {
      // The database writes one for every company (Phase 8 migration); a
      // company without one is a broken invariant, not a case to default.
      throw new Error('The company has no performance configuration');
    }
    return row;
  }

  /**
   * DOCUMENT 14: attendance "against scheduled working days". The window is
   * the month's ended days within employment; each scheduled working day is
   * judged by its record.
   */
  private async attendanceInputs(
    tx: TenantClient,
    employee: {
      readonly id: string;
      readonly workScheduleId: string;
      readonly joiningDate: Date;
      readonly terminationDate: Date | null;
    },
    month: Month,
    today: CalendarDate,
  ): Promise<{
    readonly inputs: AttendanceInputs | null;
    readonly reason: AttendanceNoDataReason | null;
    readonly from: string | null;
    readonly to: string | null;
  }> {
    const yesterday = previousDay(today);
    const joining = calendarDateIn(employee.joiningDate, 'UTC');
    const termination =
      employee.terminationDate === null ? null : calendarDateIn(employee.terminationDate, 'UTC');
    const from = latest(month.first, joining);
    const to = earliest(earliest(month.last, yesterday), termination);
    const empty: AttendanceInputs = {
      workingDays: 0,
      presentDays: 0,
      wfhDays: 0,
      paidLeaveDays: 0,
      lateIncidents: 0,
      absentDays: 0,
    };
    if (compareDates(from, to) > 0) {
      return { inputs: empty, reason: 'no_working_days', from: null, to: null };
    }

    let working: CalendarDate[];
    try {
      const context = await loadScheduleContext(tx, employee.workScheduleId, from, to);
      working = eachDay(from, to).filter(
        (date) =>
          dayFor(context, date, employee.workScheduleId).isWorkingDay &&
          !isHolidayOn(context, date),
      );
    } catch (error) {
      if (error instanceof ScheduleIncompleteError) {
        // DOCUMENT 27 RULE 12: a schedule with a missing weekday cannot say
        // which days were working days, and inventing them is the defect the
        // rule forbids. The component is reported as having no data.
        return {
          inputs: null,
          reason: 'schedule_incomplete',
          from: formatCalendarDate(from),
          to: formatCalendarDate(to),
        };
      }
      throw error;
    }

    const records = await tx.attendanceRecord.findMany({
      where: {
        employeeId: employee.id,
        date: { gte: calendarDateValue(from), lte: calendarDateValue(to) },
      },
      select: { date: true, status: true, workMode: true },
    });
    const byDate = new Map(records.map((record) => [dateToWire(record.date), record]));

    let recorded = 0;
    let presentDays = 0;
    let wfhDays = 0;
    let paidLeaveDays = 0;
    let lateIncidents = 0;
    let absentDays = 0;
    for (const date of working) {
      const record = byDate.get(formatCalendarDate(date));
      if (record === undefined) continue;
      recorded += 1;
      if (ATTENDED.has(record.status)) {
        if (record.workMode === 'wfh') wfhDays += 1;
        else presentDays += 1;
      }
      if (record.status === 'late') lateIncidents += 1;
      if (record.status === 'absent') absentDays += 1;
      if (record.status === 'on_leave') paidLeaveDays += 1;
    }
    return {
      inputs: {
        workingDays: working.length,
        presentDays,
        wfhDays,
        paidLeaveDays,
        lateIncidents,
        absentDays,
      },
      reason: working.length === 0 ? 'no_working_days' : recorded === 0 ? 'no_records' : null,
      from: formatCalendarDate(from),
      to: formatCalendarDate(to),
    };
  }

  /** DOCUMENT 14 "Task score" counts for the month. */
  private async taskInputs(
    tx: TenantClient,
    employeeId: string,
    month: Month,
    timeZone: string,
  ): Promise<TaskInputs> {
    const tasks = await tx.task.findMany({
      where: {
        assigneeEmployeeId: employeeId,
        deletedAt: null,
        status: { not: 'cancelled' },
        OR: [
          {
            deadline: {
              gte: calendarDateValue(month.first),
              lte: calendarDateValue(month.last),
            },
          },
          {
            deadline: null,
            createdAt: {
              gte: instantAt(month.first, 0, timeZone),
              lt: instantAt(month.last, 24 * 60, timeZone),
            },
          },
        ],
      },
      select: { status: true, deadline: true, completedAt: true },
    });
    let completed = 0;
    let completedOnTime = 0;
    for (const task of tasks) {
      if (task.status !== 'completed' || task.completedAt === null) continue;
      completed += 1;
      const day = formatCalendarDate(calendarDateIn(task.completedAt, timeZone));
      if (task.deadline === null || day <= dateToWire(task.deadline)) {
        completedOnTime += 1;
      }
    }
    return { assigned: tasks.length, completed, completedOnTime };
  }

  /**
   * DOCUMENT 14 "Goal score": the employee's goals in the period, each at the
   * value its history held at the end of the month (or now).
   */
  private async goalInputs(
    tx: TenantClient,
    employee: { readonly id: string; readonly terminationDate: Date | null },
    month: Month,
    timeZone: string,
  ): Promise<EmployeePerformancePayload['components']['goal']['goals']> {
    // Everything written before the month ended — for the current month,
    // everything written so far.
    const asOf = instantAt(month.last, 24 * 60, timeZone);
    const goals = await tx.goal.findMany({
      where: {
        employeeId: employee.id,
        deletedAt: null,
        status: { not: 'cancelled' },
        periodStart: { lte: calendarDateValue(month.last) },
        periodEnd: { gte: calendarDateValue(month.first) },
        createdAt: { lt: asOf },
      },
      select: { id: true, title: true, type: true, periodStart: true, periodEnd: true },
      orderBy: [{ periodEnd: 'asc' }, { id: 'asc' }],
    });
    const termination =
      employee.terminationDate === null ? null : dateToWire(employee.terminationDate);
    const result: {
      id: string;
      title: string;
      type: GoalTypeValue;
      progress_percent: string;
    }[] = [];
    for (const goal of goals) {
      const snapshot = await tx.goalProgress.findFirst({
        where: { goalId: goal.id, createdAt: { lt: asOf } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { value: true, targetValue: true },
      });
      if (snapshot === null) continue;
      const target = effectiveTarget(
        valueToWire(snapshot.targetValue),
        dateToWire(goal.periodStart),
        dateToWire(goal.periodEnd),
        termination,
      );
      result.push({
        id: goal.id,
        title: goal.title,
        type: goal.type as GoalTypeValue,
        progress_percent: progressPercent(valueToWire(snapshot.value), target),
      });
    }
    return result;
  }
}

interface Month {
  readonly key: string;
  readonly first: CalendarDate;
  readonly last: CalendarDate;
}

/** `YYYY-MM`, defaulting to the company's current month; a future month is refused. */
function resolveMonth(value: string | undefined, today: CalendarDate): Month {
  const key =
    value ?? `${String(today.year).padStart(4, '0')}-${String(today.month).padStart(2, '0')}`;
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  const year = Number(match?.[1]);
  const monthNumber = Number(match?.[2]);
  const first = parseCalendarDate(`${key}-01`);
  if (match === null || first === null) {
    throw fieldError({ month: ['invalid'] });
  }
  if (compareDates(first, { year: today.year, month: today.month, day: 1 }) > 0) {
    throw fieldError({ month: ['invalid'] });
  }
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { key, first, last: { year, month: monthNumber, day: lastDay } };
}

function previousDay(date: CalendarDate): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) - 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function latest(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) >= 0 ? a : b;
}

function earliest(a: CalendarDate, b: CalendarDate | null): CalendarDate {
  return b === null || compareDates(a, b) <= 0 ? a : b;
}

function readConfig(row: {
  readonly schemaVersion: number;
  readonly config: Prisma.JsonValue;
}): PerformanceConfig {
  if (row.schemaVersion !== PERFORMANCE_CONFIG_VERSION) {
    throw new Error(`Unsupported performance_config schema version ${String(row.schemaVersion)}`);
  }
  const parsed = parsePerformanceConfig(row.config);
  if (!parsed.ok) {
    throw new Error('The stored performance configuration is not valid');
  }
  return parsed.config;
}

function configPayload(
  row: {
    readonly schemaVersion: number;
    readonly updatedAt: Date;
    readonly updatedByUser: Parameters<typeof personRef>[0] | null;
  },
  config: PerformanceConfig,
): PerformanceConfigPayload {
  return {
    schema_version: row.schemaVersion,
    ...performanceConfigToJson(config),
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedByUser === null ? null : personRef(row.updatedByUser),
  };
}
