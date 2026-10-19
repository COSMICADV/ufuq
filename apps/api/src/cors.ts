/**
 * CORS for the web client — OD-02, DOCUMENT 20 §6.
 *
 * The web client authenticates with cookies, so the browser origin is an
 * allow-list of exactly one and credentials are permitted. It is a different
 * origin from the API, so a response header a screen must read has to be
 * exposed explicitly: a report export's file name and row count (Phase 12,
 * DOCUMENT 18 "Export & print") and a rate limit's `Retry-After`.
 */

import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js';

export const EXPOSED_HEADERS = ['Content-Disposition', 'X-Report-Rows', 'Retry-After'] as const;

export function corsOptions(webOrigin: string): CorsOptions {
  return { origin: webOrigin, credentials: true, exposedHeaders: [...EXPOSED_HEADERS] };
}
