/**
 * The two request attributes DOCUMENT 21 "Record content" asks every audit
 * record to carry.
 *
 * A decorator rather than a helper each controller calls: an audit record
 * missing its origin is not something a reviewer notices, so the shape that
 * carries it is the one a handler receives without asking.
 */

import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestOrigin {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export const RequestContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestOrigin => {
    const request = context.switchToHttp().getRequest<Request>();
    return {
      ipAddress: request.ip ?? null,
      // The column is VARCHAR(500); a longer header is truncated rather than
      // failing the write it is only describing.
      userAgent: request.headers['user-agent']?.slice(0, 500) ?? null,
    };
  },
);
