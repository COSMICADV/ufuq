/** Extracts the `AuthContext` `SessionAuthGuard` attached to the request. */

import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthContext } from '../auth-context.js';

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.authContext) {
      // A route without `@Public()` always has one by the time a handler
      // runs — `SessionAuthGuard` either sets it or the request never reaches
      // here. Reaching this means the guard was bypassed some other way,
      // which is a defect in the route's wiring, not a client error.
      throw new Error(
        'CurrentUser used on a route with no authContext — is SessionAuthGuard applied?',
      );
    }
    return request.authContext;
  },
);
