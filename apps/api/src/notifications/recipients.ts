/**
 * Recipient resolution — DOCUMENT 19 rule 1: "Recipient resolution follows
 * permissions. A manager is notified about their team; an admin about the
 * company. Never notify someone about a record they cannot open."
 *
 * Recipients are found the way an endpoint authorizes a caller: through the
 * role grants in `role_permissions` and DOCUMENT 09 §4's scopes, in SQL,
 * before anyone is selected. Never "every user, filtered later".
 *
 *   - **company** scope: the holder may open every record of that kind;
 *   - **team** scope: only when the holder is the subject employee's manager
 *     (`employees.manager_id`), exactly the team constraint every module
 *     applies;
 *   - **self** scope never makes someone an approver or a supervisor of
 *     another's record; an employee is told about their own records through
 *     {@link RecipientResolver.userOfEmployee}.
 *
 * Every recipient is an **active** user of this company (DOCUMENT 19
 * "Validation"): not deactivated, not deleted, not the company's system
 * actor, and — where the user is an employee — an employee who is still
 * active. Row-level security already confines every read to the tenant; the
 * same-company condition is also in the query. A user of another company
 * cannot be returned.
 */

import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@ufuq/auth';
import { Prisma } from '@ufuq/db';
import type { TenantClient } from '@ufuq/db';

export interface Subject {
  /** The employee whose record it is. */
  readonly employeeId: string;
  /** Their manager, for team-scoped holders. */
  readonly managerId: string | null;
}

@Injectable()
export class RecipientResolver {
  /**
   * The users whose role grants `permission` over `subject`'s records: at
   * company scope, or at team scope when they manage the subject. With
   * `subject` null (a product, a payroll period) only company scope can
   * reach the record.
   */
  async holders(
    tx: TenantClient,
    companyId: string,
    permission: PermissionKey,
    subject: Subject | null,
  ): Promise<string[]> {
    const managerId = subject?.managerId ?? null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT u."id"
        FROM "users" u
        JOIN "role_permissions" rp ON rp."role_id" = u."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id" AND p."key" = ${permission}
        LEFT JOIN "employees" me ON me."user_id" = u."id" AND me."deleted_at" IS NULL
       WHERE u."company_id" = ${companyId}::uuid
         AND u."status" = 'active' AND NOT u."is_system" AND u."deleted_at" IS NULL
         AND (me."id" IS NULL OR me."status" = 'active')
         AND (
           rp."scope" = 'company'
           OR (rp."scope" = 'team' AND ${managerId}::uuid IS NOT NULL AND me."id" = ${managerId}::uuid)
         )
       ORDER BY u."id"`;
    return rows.map((row) => row.id);
  }

  /** The employee's own active account, or null (no account, invited, deactivated). */
  async userOfEmployee(tx: TenantClient, employeeId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT u."id"
        FROM "employees" e
        JOIN "users" u ON u."id" = e."user_id"
       WHERE e."id" = ${employeeId}::uuid AND e."deleted_at" IS NULL AND e."status" = 'active'
         AND u."status" = 'active' AND NOT u."is_system" AND u."deleted_at" IS NULL`;
    return rows[0]?.id ?? null;
  }

  /** Several employees' own accounts at once, keyed by employee. */
  async usersOfEmployees(
    tx: TenantClient,
    employeeIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (employeeIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ employee_id: string; user_id: string }[]>`
      SELECT e."id" AS employee_id, u."id" AS user_id
        FROM "employees" e
        JOIN "users" u ON u."id" = e."user_id"
       WHERE e."id" IN (${Prisma.join(employeeIds.map((id) => Prisma.sql`${id}::uuid`))})
         AND e."deleted_at" IS NULL AND e."status" = 'active'
         AND u."status" = 'active' AND NOT u."is_system" AND u."deleted_at" IS NULL`;
    return new Map(rows.map((row) => [row.employee_id, row.user_id]));
  }

  /** Whether `userId` is an active user who could receive a notification. */
  async isActiveUser(tx: TenantClient, userId: string): Promise<boolean> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "users" u
       WHERE u."id" = ${userId}::uuid
         AND u."status" = 'active' AND NOT u."is_system" AND u."deleted_at" IS NULL`;
    return rows.length > 0;
  }
}
