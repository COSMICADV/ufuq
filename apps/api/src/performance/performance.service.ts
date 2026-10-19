/**
 * Performance — DOCUMENT 14 "Performance", DOCUMENT 08 §4.2 and §4.3.
 *
 *   - `GET/PATCH /performance-config` — the company's model, validated by
 *     `performance-config.ts` and audited as
 *     `settings.performance_weights_changed` (DOCUMENT 21).
 *   - `GET /employees/{id}/performance?month=YYYY-MM` — one employee's
 *     scores for a month, computed by `performance-month.ts` — the one
 *     calculation the Phase 12 reports and monthly snapshots also use. This
 *     file decides no number itself.
 *
 * Scope (DOCUMENT 09 §4): another company's employee is a 404; an employee in
 * the tenant outside the caller's `report.employee_monthly` scope is a 403.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient, TenantClient } from '@ufuq/db';

import { calendarDateIn } from '../attendance/zoned-time.js';
import { AuditDispatcher } from '../auth/audit-dispatcher.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';
import { employeeScopeWhere, forbidden } from '../employees/employee-query.js';
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
import {
  monthlyPerformance,
  PERFORMANCE_SUBJECT_SELECT,
  readConfig,
  resolveMonth,
} from './performance-month.js';
import type { EmployeePerformancePayload } from './performance-month.js';

export type { AttendanceNoDataReason, EmployeePerformancePayload } from './performance-month.js';

export interface PerformanceConfigPayload extends PerformanceConfigJson {
  readonly schema_version: number;
  readonly updated_at: string;
  /** Null while the company still has the default the database wrote. */
  readonly updated_by: PersonRef | null;
}

const PERSON_SELECT = {
  id: true,
  email: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

@Injectable()
export class PerformanceService extends TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditDispatcher) private readonly audit: AuditDispatcher,
  ) {
    super(prisma, audit);
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
        select: PERFORMANCE_SUBJECT_SELECT,
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
      const company = await tx.company.findFirstOrThrow({ select: { timezone: true } });
      const today = calendarDateIn(now, company.timezone);
      const month = resolveMonth(query.month, today);
      // The same calculation the Phase 12 reports and monthly snapshots use.
      const scores = await monthlyPerformance(
        tx,
        [employee],
        month,
        today,
        company.timezone,
        configRow,
      );
      return scores.get(employee.id) as EmployeePerformancePayload;
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
