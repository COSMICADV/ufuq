/**
 * Audit writes for the authentication action group — DOCUMENT 21.
 *
 * Every call takes the caller's own transaction (`tx`, a `TenantClient`),
 * not the shared `PrismaClient`: the record is written *inside* the same
 * transaction as the action it documents, so "audit after commit" (DOCUMENT
 * 21 "Business rules" §1) is a consequence of ordinary transaction atomicity
 * rather than a second, separate write that could succeed or fail
 * independently of the action itself. A rolled-back login attempt — there
 * is no such thing here, since nothing about login is transactional beyond
 * the audit write itself — produces no audit record, by the same logic that
 * makes any other rollback produce none.
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
}

@Injectable()
export class AuditService {
  async record(tx: TenantClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        id: generateId(),
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
