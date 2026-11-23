import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';

import { AuthModule } from '../auth/auth.module.js';

import { IdentityController } from './identity.controller.js';
import { MAX_LOGO_BYTES } from './identity-rules.js';
import { IdentityService } from './identity.service.js';

/**
 * Business Identity. Uses the process-wide private bucket (exported by the
 * global AttachmentsModule); its own Multer limits: two small files, kept in
 * memory, never written to disk.
 */
@Module({
  imports: [
    AuthModule,
    MulterModule.register({
      limits: { fileSize: MAX_LOGO_BYTES + 1, files: 2, fields: 2, parts: 4, fieldSize: 64 },
    }),
  ],
  controllers: [IdentityController],
  providers: [IdentityService],
})
export class IdentityModule {}
