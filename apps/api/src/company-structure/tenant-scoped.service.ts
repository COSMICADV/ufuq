/**
 * The base every company-structure service extends.
 *
 * Two things live here because both are easy to forget once and impossible to
 * notice afterwards:
 *
 *   1. `withTenant` is the only route to the database. A service that reached
 *      for `this.prisma` directly would run outside the `app.company_id`
 *      binding row-level security reads, and RLS would then refuse every row —
 *      loudly, which is the right failure, but the point is that there is no
 *      second way to get there (DOCUMENT 27 RULE 10, AD-03).
 *
 *   2. `fieldError` and `notFound` build the DOCUMENT 08 §2 error envelope.
 *      A raw `NotFoundException` would be answered by `ErrorFilter` with the
 *      per-status default code, which is right for a 404 and wrong for
 *      everything with more than one meaning.
 *
 *   3. **Audit after commit** (DOCUMENT 21 §1–§3). A service that audits
 *      passes its `AuditDispatcher` up (`super(prisma, audit)`), and `tenant`
 *      then opens its transactions through the dispatcher. An
 *      `audit.record(tx, …)` inside them is written once the transaction has
 *      committed, and never if it rolls back. Recording against a transaction
 *      the dispatcher did not open is refused, so a forgotten `super` argument
 *      fails loudly instead of auditing silently in the wrong place.
 */

import { Inject, Injectable } from '@nestjs/common';
import { withTenant } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { ErrorCode } from '../common/errors.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { AuditDispatcher } from '../auth/audit-dispatcher.js';

/**
 * The vocabulary of field-level failures this phase can report. A closed set,
 * not free text: the web client turns each into a translated sentence
 * (DOCUMENT 27 RULE 25 — an error message is not a place where English
 * quietly becomes the only option).
 */
export type FieldIssue =
  | 'required'
  | 'invalid'
  | 'already_taken'
  | 'not_found'
  | 'would_create_cycle'
  | 'incomplete_week'
  | 'end_before_start'
  // Phase 7 — DOCUMENT 13: "Assignee must be an active employee".
  | 'not_active'
  // Phase 7 attachments — DOCUMENT 20 §7: size and type allowlist.
  | 'too_large'
  | 'unsupported_type'
  // Phase 8 — DOCUMENT 14 "Validation": performance weights must sum to
  // exactly 1.0; DOCUMENT 13: a linked goal must belong to the task's
  // assignee when it is employee-scoped.
  | 'must_sum_to_one'
  | 'not_same_employee'
  | 'cancelled'
  // Phase 10 — DOCUMENT 16 "Validation": leave starts on or after joining,
  // ends by any termination, needs a complete schedule, and an adjustment
  // cannot drop an entitlement below the days already used or held.
  | 'before_joining'
  | 'after_termination'
  | 'schedule_incomplete'
  | 'below_committed'
  // Phase 11 — DOCUMENT 15: a salary change must start after the latest row
  // (history is never re-cut); the finalization confirmation must match.
  | 'not_after_current'
  | 'mismatch'
  // Phase 12 — DOCUMENT 18: a monthly snapshot is of a closed month; a
  // filter that does not belong to the report being asked for is refused.
  | 'not_closed'
  | 'not_allowed';

@Injectable()
export abstract class TenantScopedService {
  constructor(
    @Inject(PRISMA_CLIENT) protected readonly prisma: PrismaClient,
    /**
     * Passed up by every service that audits (`super(prisma, audit)`). Its
     * transactions are then opened by the dispatcher, so `audit.record(tx, …)`
     * inside them is written after commit (DOCUMENT 21 §1–§3). Deliberately
     * undecorated: Nest would otherwise inherit the injection into every
     * subclass, including the ones that never audit.
     */
    private readonly postCommitAudit: AuditDispatcher | null = null,
  ) {}

  protected tenant<T>(ctx: AuthContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.postCommitAudit === null
      ? withTenant(this.prisma, ctx.companyId, fn)
      : this.postCommitAudit.withTenant(ctx.companyId, fn);
  }
}

/**
 * 422 with a field map — DOCUMENT 08 §2. Used for a body that is syntactically
 * fine but references something that does not exist, or breaks a uniqueness
 * rule the database only discovers on write.
 */
export function fieldError(fields: Readonly<Record<string, readonly FieldIssue[]>>): AppException {
  return new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields });
}

/**
 * 404 — DOCUMENT 08 §3: "Not found **or outside tenant scope**". The two are
 * deliberately indistinguishable. Row-level security has already made another
 * company's row invisible by the time this is reached, so this function is
 * never *told* which of the two happened, and therefore cannot leak it.
 */
export function notFound(): AppException {
  return new AppException(ERROR_CODES.NOT_FOUND, 404);
}

/** 409 — DOCUMENT 08 §3's "business conflict", with the specific code. */
export function conflict(code: ErrorCode): AppException {
  return new AppException(code, 409);
}

/**
 * PostgreSQL reports a unique violation as `P2002` through Prisma. Turning it
 * into the DOCUMENT 08 §2 field error is preferable to checking for the
 * duplicate first: a check-then-write races, and the constraint does not.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
