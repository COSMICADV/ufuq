/**
 * The single audit writer — DOCUMENT 21.
 *
 * `record` writes one row in the transaction it is given (`tx`, a
 * `TenantClient`). There are two ways that happens:
 *
 *   - **Post-commit, through `AuditDispatcher`** (DOCUMENT 21 §1–§3). The
 *     business transaction commits first. The dispatcher then writes each
 *     entry in its own short transaction and retries any failure, so a
 *     rollback writes no audit and an audit failure never undoes a committed
 *     action. Phase 10 Leave uses this path (the Phase 10 corrective pass).
 *   - **Inside the caller's transaction**, which is how Phases 3–9 call it. A
 *     rollback still writes no audit. But an audit-write failure there rolls
 *     back the action, which is the known divergence recorded in
 *     docs/PHASE-10-STATUS.md.
 */

import { Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { AuditAction, Prisma, TenantClient } from '@ufuq/db';

export interface AuditEntry {
  readonly companyId: string;
  /** The acting user. Never null — DOCUMENT 21 "Record content": system actions use a designated system user. */
  readonly userId: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly oldValues?: Prisma.InputJsonObject;
  readonly newValues?: Prisma.InputJsonObject;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  /**
   * Set by `AuditDispatcher` for a post-commit write: the id is fixed before
   * the first attempt so a retry after an ambiguous failure cannot write the
   * record twice, and the time is when the action committed, not when a
   * retry finally landed.
   */
  readonly id?: string;
  readonly occurredAt?: Date;
}

@Injectable()
export class AuditService {
  async record(tx: TenantClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        id: entry.id ?? generateId(),
        ...(entry.occurredAt !== undefined ? { createdAt: entry.occurredAt } : {}),
        companyId: entry.companyId,
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        // Spread rather than assigned directly: under `exactOptionalPropertyTypes`,
        // explicitly setting an optional Prisma JSON field to `undefined` is a
        // type error distinct from the key being absent, even though both
        // produce the same SQL. Omitting the key entirely when there is no
        // value keeps both TypeScript and DOCUMENT 21 ("only changed fields
        // are stored") satisfied.
        ...(entry.oldValues !== undefined ? { oldValues: entry.oldValues } : {}),
        ...(entry.newValues !== undefined ? { newValues: entry.newValues } : {}),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }
}
