/**
 * The multipart limits every upload endpoint shares — DOCUMENT 20 §7.
 *
 * `POST /attachments` (Phase 7) and `POST /leave-requests` with a file
 * (Phase 10, DOCUMENT 16 rule 9) register Multer with exactly these options,
 * so a file is refused the same way whichever endpoint carries it. The
 * service re-checks every limit (`AttachmentsService.prepareUpload`).
 */

import type { MulterModuleOptions } from '@nestjs/platform-express';
import type { Env } from '@ufuq/config';

export function uploadMulterOptions(env: Env, extraFields = 0): MulterModuleOptions {
  return {
    // Multer's default engine keeps the file in memory — nothing is ever
    // written to the API host's disk, let alone a web root.
    limits: {
      // Busboy treats *reaching* `fileSize` as exceeding it, so the limit is
      // one byte past the largest accepted file: exactly the configured size
      // is accepted, one byte more is refused.
      fileSize: env.storage.maxUploadBytes + 1,
      files: 1,
      fields: 4 + extraFields,
      parts: 6 + extraFields,
      fieldSize: 1024 + extraFields * 1024,
    },
    // A browser sends a non-Latin file name as raw UTF-8 bytes; busboy would
    // otherwise read them as Latin-1 and an Arabic name would arrive garbled.
    defParamCharset: 'utf8',
  };
}
