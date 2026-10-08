import { Catch, PayloadTooLargeException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { ERROR_CODES, errorBody } from '../common/errors.js';

/**
 * Multer refuses a file over the configured limit before the handler runs,
 * and Nest reports that as a 413. DOCUMENT 08 §2 reports a bad field as a 422
 * naming the field, so the same refusal reads the same way whichever layer
 * catches it first. Shared by every upload endpoint.
 */
@Catch(PayloadTooLargeException)
export class UploadTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(422)
      .json({ error: errorBody(ERROR_CODES.VALIDATION_FAILED, { file: ['too_large'] }) });
  }
}
