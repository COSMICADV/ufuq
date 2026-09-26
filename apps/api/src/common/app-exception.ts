/**
 * The one exception type every Phase 3+ service throws for a business or
 * authorization failure — DOCUMENT 08 §2, §3.
 *
 * `HttpException`'s built-in subclasses (`UnauthorizedException`, …) only
 * carry a status; `ErrorFilter` would then have to guess *which* 401 this is
 * from `codeForStatus`, and a status only maps to one code. `AppException`
 * names the code at the throw site instead, so "wrong password" and
 * "session expired" — both 401s — reach the client as the distinct codes
 * DOCUMENT 09 requires distinct messages for.
 *
 * The field is `appErrorCode`, not `errorCode`: `HttpException` already
 * declares an unrelated, optional `errorCode?: string` of its own (a NestJS
 * concept this codebase does not use), and shadowing it would be confusing
 * even where TypeScript would allow it.
 */

import { HttpException } from '@nestjs/common';

import type { ErrorCode } from './errors.js';

export interface AppExceptionOptions {
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  /** 429 responses (DOCUMENT 08 §6, DOCUMENT 20 §9): the `Retry-After` header value, in seconds. */
  readonly retryAfterSeconds?: number;
}

export class AppException extends HttpException {
  readonly appErrorCode: ErrorCode;
  readonly fields: Readonly<Record<string, readonly string[]>> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(errorCode: ErrorCode, status: number, options: AppExceptionOptions = {}) {
    super(errorCode, status);
    this.appErrorCode = errorCode;
    this.fields = options.fields;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
