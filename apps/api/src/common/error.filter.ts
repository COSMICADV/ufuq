/**
 * The single place an exception becomes an HTTP response.
 *
 * DOCUMENT 08 §2 fixes the error shape. DOCUMENT 08 §3 says a 500 never leaks
 * internals, and DOCUMENT 20 §8 says nothing sensitive reaches a log line, so
 * the cause is logged server-side and the client is told only the code.
 */

import { Catch, HttpException, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppException } from './app-exception.js';
import { codeForStatus, errorBody, ERROR_CODES } from './errors.js';
import type { ErrorResponse } from './envelope.js';

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    // An AppException names its own code — the only way a 401 can mean
    // "wrong password" rather than "session expired" (DOCUMENT 09 §1, §3).
    // Anything else (a framework exception, an unhandled throw) falls back
    // to the generic per-status mapping.
    const code = exception instanceof AppException ? exception.appErrorCode : codeForStatus(status);
    const fields = exception instanceof AppException ? exception.fields : undefined;

    if (code === ERROR_CODES.INTERNAL_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} failed with ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    if (exception instanceof AppException && exception.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    }

    const body: ErrorResponse = { error: errorBody(code, fields) };
    response.status(status).json(body);
  }
}
