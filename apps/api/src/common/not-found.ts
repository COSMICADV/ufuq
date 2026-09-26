/**
 * The fallback for a request that matched no route.
 *
 * Without it the HTTP adapter answers with its own HTML error page, which is
 * neither the documented envelope (DOCUMENT 08 §2) nor bilingual
 * (DOCUMENT 27 RULE 25).
 */

import type { Request, Response } from 'express';

import { ERROR_CODES, errorBody } from './errors.js';
import type { ErrorResponse } from './envelope.js';

export function notFoundHandler(_request: Request, response: Response): void {
  const body: ErrorResponse = { error: errorBody(ERROR_CODES.NOT_FOUND) };
  response.status(404).json(body);
}
