/**
 * QR Studio — the company's codes, their scans, ratings and files.
 *
 * Codes belong to the company: everyone who may open QR Studio (the company's
 * admins) sees and edits the same codes. Everything runs inside the caller's
 * tenant transaction. A scan has no session: the short link is resolved to its
 * company first (`lookupQrCodeBySlug`, SECURITY DEFINER), and the scan is then
 * written inside that company's tenant.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import {
  generateId,
  isQrSlugTaken,
  lookupQrCodeBySlug,
  lookupQrFileCompany,
  Prisma,
  withPlatformContext,
  withTenant,
} from '@ufuq/db';
import type { PrismaClient, QrCode, TenantClient } from '@ufuq/db';

import type { AuthContext } from '../auth/auth-context.js';
import { ATTACHMENT_LIMITS, OBJECT_STORAGE } from '../attachments/object-storage.js';
import type { AttachmentLimits, ObjectStorage } from '../attachments/object-storage.js';
import type { UploadedFile } from '../attachments/attachments.service.js';
import { AppException } from '../common/app-exception.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';
import { ERROR_CODES } from '../common/errors.js';

import {
  cleanRecord,
  QR_FILE_TYPES,
  QR_MAX_RECORD_BYTES,
  QR_SCAN_LOG_LIMIT,
  QR_SLUG_PATTERN,
  websiteTarget,
} from './qr-rules.js';
import type { ScanContext, ScanLogEntry } from './qr-rules.js';

/** Who may use QR Studio: the company's owner and admins. */
const STUDIO_ROLES = new Set(['super_admin', 'admin']);

/** A code as the studio reads it: its own record plus the counts the server keeps. */
export type QrCodePayload = Record<string, unknown> & {
  readonly id: string;
  readonly scans: number;
  readonly scanLog: readonly ScanLogEntry[];
  readonly feedback: readonly { stars: number; text: string; t: string }[];
};

/** What the public scan page needs to show a code. */
export interface QrScanPage {
  readonly slug: string;
  readonly type: string;
  readonly data: unknown;
  readonly page: unknown;
  /** Set for a website code: where the visitor goes. */
  readonly redirect: string | null;
}

export interface ScanInput extends ScanContext {
  readonly unique: boolean;
  readonly os: string | null;
  readonly browser: string | null;
  readonly city: string | null;
}

export interface QrFileDownload {
  readonly stream: Readable;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly fileName: string;
}

const notFound = (): AppException => new AppException(ERROR_CODES.NOT_FOUND, 404);
const invalid = (): AppException => new AppException(ERROR_CODES.VALIDATION_FAILED, 422);

@Injectable()
export class QrService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ATTACHMENT_LIMITS) private readonly limits: AttachmentLimits,
  ) {}

  /** Only the company's owner and admins work in QR Studio. */
  assertStudio(ctx: AuthContext): void {
    if (!STUDIO_ROLES.has(ctx.roleKey)) throw new AppException(ERROR_CODES.FORBIDDEN, 403);
  }

  private tenant<T>(ctx: AuthContext, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, ctx.companyId, fn);
  }

  // ---- the studio --------------------------------------------------------------------

  async list(ctx: AuthContext): Promise<QrCodePayload[]> {
    this.assertStudio(ctx);
    return this.tenant(ctx, async (tx) => {
      const codes = await tx.qrCode.findMany({ orderBy: { createdAt: 'desc' } });
      return Promise.all(codes.map((code) => this.payload(tx, code)));
    });
  }

  /** Creates or replaces the code under `slug`. A slug another company uses is a 409. */
  async save(ctx: AuthContext, slug: string, input: unknown): Promise<{ id: string }> {
    this.assertStudio(ctx);
    const clean = cleanRecord(slug, input);
    if (clean === null) throw invalid();
    const size = Buffer.byteLength(JSON.stringify(clean.record));
    if (size > QR_MAX_RECORD_BYTES) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 413);
    const record = clean.record as Prisma.InputJsonValue;
    try {
      await this.tenant(ctx, async (tx) => {
        const existing = await tx.qrCode.findUnique({ where: { slug } });
        if (existing === null) {
          await tx.qrCode.create({
            data: {
              id: generateId(),
              companyId: ctx.companyId,
              createdBy: ctx.userId,
              slug,
              name: clean.name,
              type: clean.type,
              record,
            },
          });
        } else {
          await tx.qrCode.update({
            where: { id: existing.id },
            data: { name: clean.name, type: clean.type, record },
          });
        }
      });
    } catch (error) {
      // Row-level security hides another company's code, so it surfaces as the
      // unique slug refusing the insert.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppException(ERROR_CODES.CONFLICT, 409);
      }
      throw error;
    }
    return { id: slug };
  }

  async remove(ctx: AuthContext, slug: string): Promise<void> {
    this.assertStudio(ctx);
    await this.tenant(ctx, async (tx) => {
      await tx.qrCode.deleteMany({ where: { slug } });
    });
  }

  /** Clears a code's statistics and ratings. */
  async reset(ctx: AuthContext, slug: string): Promise<void> {
    this.assertStudio(ctx);
    await this.tenant(ctx, async (tx) => {
      const code = await tx.qrCode.findUnique({ where: { slug } });
      if (code === null) throw notFound();
      await tx.qrScan.deleteMany({ where: { qrCodeId: code.id } });
      await tx.qrFeedback.deleteMany({ where: { qrCodeId: code.id } });
      await tx.qrCode.update({ where: { id: code.id }, data: { scans: 0 } });
    });
  }

  /** Whether `slug` is free for this company: unused, or already one of its own codes. */
  async slugFree(ctx: AuthContext, slug: string): Promise<boolean> {
    this.assertStudio(ctx);
    if (!QR_SLUG_PATTERN.test(slug)) return false;
    const own = await this.tenant(ctx, (tx) => tx.qrCode.findUnique({ where: { slug } }));
    if (own !== null) return true;
    return !(await withPlatformContext(this.prisma, (tx) => isQrSlugTaken(tx, slug)));
  }

  async upload(ctx: AuthContext, file: UploadedFile | undefined): Promise<{ id: string }> {
    this.assertStudio(ctx);
    if (file === undefined || file.size === 0) throw invalid();
    if (file.size > this.limits.maxUploadBytes) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 413);
    }
    const extension = QR_FILE_TYPES.get(file.mimetype);
    if (extension === undefined) throw invalid();
    const id = generateId();
    // Company-namespaced and unguessable; never built from the uploaded name.
    const key = `qr/${ctx.companyId}/${randomUUID()}.${extension}`;
    await this.storage.put({
      key,
      body: file.buffer,
      contentType: file.mimetype,
      checksum: createHash('sha256').update(file.buffer).digest('hex'),
    });
    await this.tenant(ctx, (tx) =>
      tx.qrFile.create({
        data: {
          id,
          companyId: ctx.companyId,
          createdBy: ctx.userId,
          storageKey: key,
          fileName: file.originalname.slice(0, 255) || `file.${extension}`,
          contentType: file.mimetype,
          sizeBytes: file.size,
        },
      }),
    );
    return { id };
  }

  // ---- the public scan page ----------------------------------------------------------

  private async scanTenant<T>(
    slug: string,
    fn: (tx: TenantClient, codeId: string) => Promise<T>,
  ): Promise<T> {
    if (!QR_SLUG_PATTERN.test(slug)) throw notFound();
    const found = await withPlatformContext(this.prisma, (tx) => lookupQrCodeBySlug(tx, slug));
    if (found === null) throw notFound();
    return withTenant(this.prisma, found.companyId, (tx) => fn(tx, found.id));
  }

  /** A scan: counts it and returns what the page shows (or where it sends the visitor). */
  async scan(slug: string, input: ScanInput): Promise<QrScanPage> {
    return this.scanTenant(slug, async (tx, codeId) => {
      const code = await tx.qrCode.findUnique({ where: { id: codeId } });
      if (code === null) throw notFound();
      await tx.qrScan.create({
        data: {
          id: generateId(),
          companyId: code.companyId,
          qrCodeId: code.id,
          kind: 's',
          isUnique: input.unique,
          os: input.os,
          browser: input.browser,
          lang: input.lang,
          country: input.country,
          city: input.city,
          createdAt: input.now,
        },
      });
      await tx.qrCode.update({ where: { id: code.id }, data: { scans: { increment: 1 } } });
      const record = code.record as Record<string, unknown>;
      return {
        slug,
        type: code.type,
        data: record.data ?? {},
        page: record.page ?? {},
        redirect: code.type === 'website' ? websiteTarget(record, input) : null,
      };
    });
  }

  /** A tracked click on a code's page. */
  async event(slug: string, name: string, input: ScanContext): Promise<void> {
    await this.scanTenant(slug, async (tx, codeId) => {
      const code = await tx.qrCode.findUnique({ where: { id: codeId } });
      if (code === null) throw notFound();
      await tx.qrScan.create({
        data: {
          id: generateId(),
          companyId: code.companyId,
          qrCodeId: code.id,
          kind: 'e',
          event: name.slice(0, 120),
          lang: input.lang,
          country: input.country,
          createdAt: input.now,
        },
      });
    });
  }

  /** A rating left on a feedback code's page. */
  async feedback(slug: string, stars: number, text: string): Promise<void> {
    await this.scanTenant(slug, async (tx, codeId) => {
      const code = await tx.qrCode.findUnique({ where: { id: codeId } });
      if (code === null || code.type !== 'feedback') throw notFound();
      await tx.qrFeedback.create({
        data: {
          id: generateId(),
          companyId: code.companyId,
          qrCodeId: code.id,
          stars,
          body: text.slice(0, 1000),
        },
      });
    });
  }

  async file(id: string): Promise<QrFileDownload> {
    const companyId = await withPlatformContext(this.prisma, (tx) => lookupQrFileCompany(tx, id));
    if (companyId === null) throw notFound();
    const file = await withTenant(this.prisma, companyId, (tx) =>
      tx.qrFile.findUnique({ where: { id } }),
    );
    if (file === null) throw notFound();
    return {
      stream: await this.storage.get(file.storageKey),
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      fileName: file.fileName,
    };
  }

  // ---- payload -----------------------------------------------------------------------

  private async payload(tx: TenantClient, code: QrCode): Promise<QrCodePayload> {
    const scans = await tx.qrScan.findMany({
      where: { qrCodeId: code.id },
      orderBy: { createdAt: 'desc' },
      take: QR_SCAN_LOG_LIMIT,
    });
    const ratings = await tx.qrFeedback.findMany({
      where: { qrCodeId: code.id },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const record = code.record as Record<string, unknown>;
    return {
      ...record,
      id: code.slug,
      name: code.name,
      type: code.type,
      created: typeof record.created === 'string' ? record.created : code.createdAt.toISOString(),
      scans: code.scans,
      scanLog: scans.reverse().map((s) => ({
        t: s.createdAt.toISOString(),
        k: s.kind,
        u: s.isUnique,
        os: s.os,
        browser: s.browser,
        lang: s.lang,
        country: s.country,
        city: s.city,
        event: s.event,
        name: s.event,
      })),
      feedback: ratings.map((f) => ({
        stars: f.stars,
        text: f.body,
        t: f.createdAt.toISOString(),
      })),
    };
  }
}
