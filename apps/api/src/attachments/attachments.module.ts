/**
 * The attachment store — Phase 7 addendum (DOCUMENT 08 §4.14, AD-02),
 * approved 2026-10-05.
 *
 * Generic infrastructure with tasks as its first consumer. A later consumer
 * (attendance corrections, leave, employee photos, company logos) adds one
 * {@link AttachmentPolicy} to `ATTACHMENT_POLICIES`, one value to
 * `RELATED_TYPES` and to the database CHECK, and nothing else here changes.
 *
 * Global, like `MailModule`: registered once with the environment, and its
 * service is what a consumer module asks for a record's attachments without
 * importing this module (and so without a module cycle — `TaskAttachmentPolicy`
 * lives with tasks, and tasks read attachments through `AttachmentsService`).
 *
 * `AuthModule` supplies `AuditDispatcher`; `RateLimitService` is provided here
 * from the same class (it holds no state beyond the shared Redis client), so
 * `AuthModule`'s exports stay as they were.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '@ufuq/config';

import { AuthModule } from '../auth/auth.module.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { ProductAttachmentPolicy } from '../inventory/product-attachment-policy.js';
import { LeaveAttachmentPolicy } from '../leave/leave-attachment-policy.js';
import { RequestAttachmentPolicy } from '../requests/request-attachment-policy.js';
import { TaskAttachmentPolicy } from '../tasks/task-attachment-policy.js';

import { ATTACHMENT_POLICIES } from './attachment-policy.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttachmentsService } from './attachments.service.js';
import { ATTACHMENT_LIMITS, OBJECT_STORAGE } from './object-storage.js';
import { createS3Client, S3ObjectStorage } from './s3-object-storage.js';
import { uploadMulterOptions } from './upload-limits.js';

@Module({})
export class AttachmentsModule {
  static register(env: Env): DynamicModule {
    return {
      module: AttachmentsModule,
      global: true,
      imports: [
        AuthModule,
        // Multer's default engine keeps the file in memory — nothing is ever
        // written to the API host's disk, let alone a web root. The limits are
        // the first gate (one file, the configured size, tiny text fields);
        // the service re-checks every one of them.
        MulterModule.register(uploadMulterOptions(env)),
      ],
      controllers: [AttachmentsController],
      providers: [
        AttachmentsService,
        RateLimitService,
        TaskAttachmentPolicy,
        RequestAttachmentPolicy,
        LeaveAttachmentPolicy,
        ProductAttachmentPolicy,
        {
          provide: ATTACHMENT_POLICIES,
          useFactory: (
            tasks: TaskAttachmentPolicy,
            requests: RequestAttachmentPolicy,
            leave: LeaveAttachmentPolicy,
            products: ProductAttachmentPolicy,
          ) => [tasks, requests, leave, products],
          inject: [
            TaskAttachmentPolicy,
            RequestAttachmentPolicy,
            LeaveAttachmentPolicy,
            ProductAttachmentPolicy,
          ],
        },
        {
          provide: OBJECT_STORAGE,
          useFactory: () => new S3ObjectStorage(createS3Client(env.storage), env.storage.bucket),
        },
        { provide: ATTACHMENT_LIMITS, useValue: { maxUploadBytes: env.storage.maxUploadBytes } },
      ],
      // OBJECT_STORAGE is shared with Phase 12's background report exports:
      // one private bucket for the process, not a second storage client.
      exports: [AttachmentsService, OBJECT_STORAGE],
    };
  }
}
