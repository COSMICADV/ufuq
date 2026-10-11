/**
 * The attachment store — DOCUMENT 08 §4.14, DOCUMENT 06 §3.36, DOCUMENT 20 §7,
 * DOCUMENT 21, AD-02. Phase 7 addendum, approved 2026-10-05.
 *
 * Generic over what a file belongs to: the related record's registered
 * {@link AttachmentPolicy} is asked every authorization question, so a file is
 * never more visible than its record. Only `task` is registered in Phase 7.
 *
 * Upload, in order:
 *
 *   1. **Rate limit** — 30 uploads per hour per user (DOCUMENT 08 §6),
 *      counted per attempt, so a stream of refused uploads is throttled too.
 *   2. **File checks** (DOCUMENT 20 §7): present, non-empty, within the
 *      configured size, and the declared MIME type both allowed **and** equal
 *      to the type the magic bytes say it is.
 *   3. **Authorization**, inside the tenant transaction: the record must be
 *      visible (else 404, never confirming it exists) and the caller allowed
 *      to add to it (else 403).
 *   4. **Store, record, audit** in that one transaction: the object is written
 *      under a generated `{company_id}/{256-bit random}` key, the row records
 *      the SHA-256 and the sanitised original name as metadata only, and
 *      `attachment.uploaded` is audited with metadata (never contents). If the
 *      object write fails the row and the audit roll back with it. The cost is
 *      that the transaction stays open for the duration of the object write,
 *      which a 10 MB ceiling bounds.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import { generateId } from '@ufuq/db';
import type { PrismaClient, TenantClient } from '@ufuq/db';

import { AuditService } from '../auth/audit.service.js';
import type { AuditEntry } from '../auth/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';
import type { RequestOrigin } from '../common/request-context.js';
import {
  fieldError,
  notFound,
  TenantScopedService,
} from '../company-structure/tenant-scoped.service.js';

import { ATTACHMENT_POLICIES } from './attachment-policy.js';
import type { AttachmentPolicy, RelatedType } from './attachment-policy.js';
import {
  ATTACHMENT_INCLUDE,
  attachmentAuditSnapshot,
  attachmentPayload,
} from './attachment-payload.js';
import type { AttachmentPayload, AttachmentRow } from './attachment-payload.js';
import { contentDisposition, sanitizeFileName } from './file-name.js';
import { detectMime, isAllowedMime } from './file-type.js';
import { ATTACHMENT_LIMITS, OBJECT_STORAGE } from './object-storage.js';
import type { AttachmentLimits, ObjectStorage } from './object-storage.js';
import type { UploadAttachmentDto } from './dto/attachment.dto.js';

/** DOCUMENT 08 §6 — "`/attachments`: 30 per hour per user". */
export const UPLOAD_RATE_LIMIT_MAX = 30;
export const UPLOAD_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

/** The parts of a multipart file the service reads (multer's in-memory file). */
/** A file that has passed DOCUMENT 20 §7's checks, ready to store. */
export interface CheckedUpload {
  readonly buffer: Buffer;
  readonly mime: string;
  readonly name: string;
  readonly checksum: string;
}

export interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

/** What `GET /attachments/{id}` streams, and the headers that describe it. */
export interface AttachmentDownload {
  readonly stream: Readable;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly disposition: string;
  readonly checksum: string;
}

@Injectable()
export class AttachmentsService extends TenantScopedService {
  private readonly policies: ReadonlyMap<string, AttachmentPolicy>;

  constructor(
    @Inject(PRISMA_CLIENT) prisma: PrismaClient,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ATTACHMENT_LIMITS) private readonly limits: AttachmentLimits,
    @Inject(ATTACHMENT_POLICIES) policies: readonly AttachmentPolicy[],
  ) {
    super(prisma);
    this.policies = new Map(policies.map((policy) => [policy.relatedType, policy]));
  }

  async upload(
    ctx: AuthContext,
    file: UploadedFile | undefined,
    dto: UploadAttachmentDto,
    origin: RequestOrigin,
  ): Promise<AttachmentPayload> {
    const checked = await this.prepareUpload(ctx, file);
    const policy = this.policyFor(dto.related_type);

    return this.tenant(ctx, async (tx) => {
      await this.authorize(tx, ctx, policy, dto.related_id, 'upload');
      return this.storeChecked(tx, ctx, checked, dto.related_type, dto.related_id, origin);
    });
  }

  /**
   * Everything that can be said about an upload before a transaction opens:
   * the caller's upload allowance (rate limit) and DOCUMENT 20 §7's checks on
   * the bytes — size, declared type against magic bytes, file name.
   */
  async prepareUpload(ctx: AuthContext, file: UploadedFile | undefined): Promise<CheckedUpload> {
    const limit = await this.rateLimit.consume(
      `attachments:upload:user:${ctx.userId}`,
      UPLOAD_RATE_LIMIT_MAX,
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (!limit.allowed) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 429, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    return this.checkFile(file);
  }

  /**
   * Store a checked file against a record, inside the caller's transaction:
   * the row, its `attachment.uploaded` audit, then the private object.
   *
   * `upload` uses it after asking the record's policy. A consumer that
   * creates the record and its file together (a leave request whose type
   * requires an attachment — DOCUMENT 16 rule 9) calls it directly, having
   * authorized the creation itself, so the record and its file commit or roll
   * back as one. Such a consumer may pass `postCommitAudits`: the
   * `attachment.uploaded` entry is then added there for it to dispatch after
   * commit (`AuditDispatcher`) instead of being written in `tx`.
   */
  async storeChecked(
    tx: TenantClient,
    ctx: AuthContext,
    checked: CheckedUpload,
    relatedType: RelatedType,
    relatedId: string,
    origin: RequestOrigin,
    postCommitAudits?: AuditEntry[],
  ): Promise<AttachmentPayload> {
    const id = generateId();
    // 256 random bits under the company's own prefix — DOCUMENT 06 §3.36
    // "non-guessable key", DOCUMENT 20 §3 "company-namespaced paths". Nothing
    // the client sent takes part in it.
    const storedPath = `${ctx.companyId}/${randomBytes(32).toString('hex')}`;
    const row = await tx.attachment.create({
      data: {
        id,
        companyId: ctx.companyId,
        uploadedBy: ctx.userId,
        originalName: checked.name,
        storedPath,
        mimeType: checked.mime,
        sizeBytes: checked.buffer.length,
        checksum: checked.checksum,
        relatedType,
        relatedId,
      },
      include: ATTACHMENT_INCLUDE,
    });
    const uploaded: AuditEntry = {
      companyId: ctx.companyId,
      userId: ctx.userId,
      action: 'ATTACHMENT_UPLOADED',
      entityType: 'attachment',
      entityId: id,
      newValues: attachmentAuditSnapshot(row),
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    };
    if (postCommitAudits === undefined) {
      await this.audit.record(tx, uploaded);
    } else {
      postCommitAudits.push(uploaded);
    }
    await this.storage.put({
      key: storedPath,
      body: checked.buffer,
      contentType: checked.mime,
      checksum: checked.checksum,
    });
    return attachmentPayload(row);
  }

  /**
   * DOCUMENT 08 §4.14 "authorization-checked stream; never a public URL".
   * Missing, deleted, another company's, or attached to a record the caller
   * cannot see: the same 404 (DOCUMENT 20 §3, DOCUMENT 26 §5).
   */
  async download(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<AttachmentDownload> {
    const row = await this.tenant(ctx, async (tx) => {
      const found = await this.loadVisible(tx, ctx, id);
      const policy = this.policyFor(found.relatedType);
      if (policy.sensitive) {
        // DOCUMENT 21 — `attachment.accessed`, "sensitive attachments only".
        await this.audit.record(tx, {
          companyId: ctx.companyId,
          userId: ctx.userId,
          action: 'ATTACHMENT_ACCESSED',
          entityType: 'attachment',
          entityId: found.id,
          newValues: attachmentAuditSnapshot(found),
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        });
      }
      return found;
    });
    return {
      stream: await this.storage.get(row.storedPath),
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      disposition: contentDisposition(row.originalName),
      checksum: row.checksum,
    };
  }

  /** DOCUMENT 08 §4.14 "soft delete, audited". The stored object is retained. */
  async remove(ctx: AuthContext, id: string, origin: RequestOrigin): Promise<void> {
    await this.tenant(ctx, async (tx) => {
      const row = await this.loadVisible(tx, ctx, id);
      await this.authorize(tx, ctx, this.policyFor(row.relatedType), row.relatedId, 'delete');
      await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record(tx, {
        companyId: ctx.companyId,
        userId: ctx.userId,
        action: 'ATTACHMENT_DELETED',
        entityType: 'attachment',
        entityId: id,
        oldValues: attachmentAuditSnapshot(row),
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    });
  }

  /**
   * The live attachments of one record, newest first — for a consumer that
   * has already authorized the caller to see that record (the task detail).
   */
  async listFor(
    tx: TenantClient,
    relatedType: RelatedType,
    relatedId: string,
  ): Promise<readonly AttachmentPayload[]> {
    const rows = await tx.attachment.findMany({
      where: { relatedType, relatedId, deletedAt: null },
      include: ATTACHMENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(attachmentPayload);
  }

  /** The upload and delete answers for one record, for a screen to render its controls. */
  async abilitiesFor(
    tx: TenantClient,
    ctx: AuthContext,
    relatedType: RelatedType,
    relatedId: string,
  ): Promise<{ readonly canUpload: boolean; readonly canDelete: boolean }> {
    const policy = this.policyFor(relatedType);
    const [canUpload, canDelete] = await Promise.all([
      policy.canUpload(tx, ctx, relatedId),
      policy.canDelete(tx, ctx, relatedId),
    ]);
    return { canUpload, canDelete };
  }

  // -- internals -------------------------------------------------------------

  private policyFor(relatedType: string): AttachmentPolicy {
    const policy = this.policies.get(relatedType);
    if (policy === undefined) {
      // The DTO and the database CHECK both refuse an unknown type first; a
      // stored row with an unregistered type is a deployment fault.
      throw fieldError({ related_type: ['invalid'] });
    }
    return policy;
  }

  /** Row-level security hides other companies; the policy hides what the caller may not see. */
  private async loadVisible(
    tx: TenantClient,
    ctx: AuthContext,
    id: string,
  ): Promise<AttachmentRow> {
    const row = await tx.attachment.findFirst({
      where: { id, deletedAt: null },
      include: ATTACHMENT_INCLUDE,
    });
    if (row === null) {
      throw notFound();
    }
    if (!(await this.policyFor(row.relatedType).canView(tx, ctx, row.relatedId))) {
      throw notFound();
    }
    return row;
  }

  private async authorize(
    tx: TenantClient,
    ctx: AuthContext,
    policy: AttachmentPolicy,
    relatedId: string,
    action: 'upload' | 'delete',
  ): Promise<void> {
    if (!(await policy.canView(tx, ctx, relatedId))) {
      throw notFound();
    }
    const allowed =
      action === 'upload'
        ? await policy.canUpload(tx, ctx, relatedId)
        : await policy.canDelete(tx, ctx, relatedId);
    if (!allowed) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 403);
    }
  }

  /** DOCUMENT 20 §7 — everything that can be said about the bytes before the database is touched. */
  private checkFile(file: UploadedFile | undefined): CheckedUpload {
    if (file === undefined || file.buffer.length === 0) {
      throw fieldError({ file: ['required'] });
    }
    if (file.buffer.length > this.limits.maxUploadBytes) {
      throw fieldError({ file: ['too_large'] });
    }
    const declared = file.mimetype.trim().toLowerCase();
    const detected = detectMime(file.buffer);
    if (!isAllowedMime(declared) || detected !== declared) {
      throw fieldError({ file: ['unsupported_type'] });
    }
    return {
      buffer: file.buffer,
      mime: detected,
      name: sanitizeFileName(file.originalname),
      checksum: createHash('sha256').update(file.buffer).digest('hex'),
    };
  }
}
