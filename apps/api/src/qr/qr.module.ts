/**
 * QR Studio — dynamic, branded QR codes for the company (the 1to1QR studio,
 * part of 1to1OS). Object storage comes from the global AttachmentsModule.
 */

import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import type { Env } from '@ufuq/config';

import { ATTACHMENT_LIMITS } from '../attachments/object-storage.js';
import { uploadMulterOptions } from '../attachments/upload-limits.js';

import { QrController, QrPublicController } from './qr.controller.js';
import { QrService } from './qr.service.js';

@Module({})
export class QrModule {
  static register(env: Env): DynamicModule {
    return {
      module: QrModule,
      imports: [MulterModule.register(uploadMulterOptions(env))],
      controllers: [QrController, QrPublicController],
      providers: [
        QrService,
        { provide: ATTACHMENT_LIMITS, useValue: { maxUploadBytes: env.storage.maxUploadBytes } },
      ],
    };
  }
}
