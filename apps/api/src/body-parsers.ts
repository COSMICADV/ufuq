/**
 * Request body parsers, registered by `main.ts` (and the end-to-end suites)
 * instead of by Nest.
 */

import type { IncomingMessage } from 'node:http';

import type { NestExpressApplication } from '@nestjs/platform-express';

import { API_PREFIX } from './api-prefix.js';

/** JSON a QR Studio save may carry: the studio embeds compressed pictures in a code's record. */
const QR_SAVE_PATH = `/${API_PREFIX}/qr/codes/`;
const QR_SAVE_LIMIT = '9mb';

function isJson(request: IncomingMessage): boolean {
  const type = request.headers['content-type'];
  return typeof type === 'string' && /^application\/json\b/i.test(type);
}

/**
 * Nest's own parsers (JSON and form bodies, 100 KB), plus a larger JSON limit
 * for the one route that needs it — a QR Studio save — so no other endpoint
 * accepts a bigger body than before.
 */
export function registerBodyParsers(app: NestExpressApplication): void {
  const isQrSave = (request: IncomingMessage): boolean =>
    (request.url ?? '').startsWith(QR_SAVE_PATH) && isJson(request);
  app.useBodyParser('json', { limit: QR_SAVE_LIMIT, type: isQrSave });
  app.useBodyParser('json', {
    type: (request: IncomingMessage) => !isQrSave(request) && isJson(request),
  });
  app.useBodyParser('urlencoded', { extended: true });
}
