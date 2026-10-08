/**
 * Who may see, add and remove the attachments of a record.
 *
 * The attachment store is generic; authorization is not. An attachment is
 * exactly as visible as the record it belongs to, so each `related_type`
 * registers a policy that answers in that record's own terms — a task in
 * `task.view` scope, a leave request (later) in its own. There is no
 * attachment permission that could reach a record its owner's rules would
 * not (DOCUMENT 20 §3: authorization lives with the data).
 *
 * Every method runs inside the caller's tenant transaction, so row-level
 * security has already hidden other companies' records before any of these
 * questions is asked.
 */

import type { TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';

/**
 * The record kinds an attachment may belong to. Mirrors the database CHECK
 * `attachments_related_type_known`; a consumer added later extends both.
 */
export const RELATED_TYPES = ['task', 'request', 'leave_request'] as const;
export type RelatedType = (typeof RELATED_TYPES)[number];

export interface AttachmentPolicy {
  readonly relatedType: RelatedType;
  /**
   * DOCUMENT 21: `attachment.accessed` is recorded for **sensitive**
   * attachments only. A policy whose records are sensitive (a payslip, say)
   * sets this; a task's working files do not.
   */
  readonly sensitive: boolean;
  /** Is the record visible to the caller? `false` is a 404 — its existence is not confirmed. */
  canView(tx: TenantClient, ctx: AuthContext, relatedId: string): Promise<boolean>;
  /** May the caller add a file to this (visible) record? `false` is a 403. */
  canUpload(tx: TenantClient, ctx: AuthContext, relatedId: string): Promise<boolean>;
  /** May the caller remove a file from this (visible) record? `false` is a 403. */
  canDelete(tx: TenantClient, ctx: AuthContext, relatedId: string): Promise<boolean>;
}

/** DI token for the registered policies, one per {@link RelatedType}. */
export const ATTACHMENT_POLICIES = Symbol('ufuq.api.attachment-policies');
