/**
 * Server-side input validation — DOCUMENT 08 §5, DOCUMENT 20 §4, DOCUMENT 27
 * RULE 28.
 *
 * `whitelist` + `forbidNonWhitelisted` reject any field not declared on the
 * DTO rather than silently dropping it (DOCUMENT 08 §5.2) — the ValidationPipe
 * default of silently stripping unknown fields is not what DOCUMENT 08 asks
 * for. Every failure becomes 422 `VALIDATION_FAILED` with a `fields` map
 * (DOCUMENT 08 §2), not the ValidationPipe default of 400.
 */

import { ValidationPipe } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';

import { AppException } from './app-exception.js';
import { ERROR_CODES } from './errors.js';

function flatten(errors: readonly ValidationError[], prefix = ''): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    if (error.constraints) {
      fields[path] = Object.values(error.constraints);
    }
    if (error.children && error.children.length > 0) {
      Object.assign(fields, flatten(error.children, path));
    }
  }
  return fields;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new AppException(ERROR_CODES.VALIDATION_FAILED, 422, { fields: flatten(errors) }),
  });
}
