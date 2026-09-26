/**
 * DOCUMENT 09 §4 check 1 (AUTHENTICATED) and the point at which check 2
 * (TENANT SCOPE) begins: resolving the session is what binds `company_id`
 * to the request, and it is bound here — from the session, never from
 * anything the client sent (DOCUMENT 08 §1 "Critical rule", DOCUMENT 20 §3).
 */

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

import { Reflector } from '@nestjs/core';
import { isSystemRoleKey, permissionsForRole } from '@ufuq/auth';
import { withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import type { Request } from 'express';

import { PRISMA_CLIENT } from '../../common/db.tokens.js';
import type { AuthContext } from '../auth-context.js';
import { SESSION_COOKIE_NAME } from '../cookies.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

import { SessionService } from '../session.service.js';

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const { token, clientType } = extractToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    const resolved = await this.sessions.resolveAndTouch(token);
    if (!resolved) {
      throw new UnauthorizedException();
    }

    const authContext = await withTenant(this.prisma, resolved.companyId, async (tx) => {
      const user = await tx.user.findUnique({ where: { id: resolved.userId } });
      // DOCUMENT 09 §6 "Deactivation" invalidates every session immediately;
      // this is the defensive re-check in case that ever fails to keep up.
      if (!user || user.status !== 'active') {
        return null;
      }
      const company = await tx.company.findUnique({ where: { id: resolved.companyId } });
      if (!company || company.status !== 'active') {
        return null;
      }
      const role = await tx.role.findUnique({ where: { id: user.roleId } });
      if (!role || !isSystemRoleKey(role.key)) {
        return null;
      }
      // DOCUMENT 02 §3 / DOCUMENT 09 §4: `self` and `team` scopes resolve
      // against the caller's employee record. A user with none (the seeded
      // first admin, for instance) keeps `null`, and `resolveScope` refuses
      // those scopes for them rather than this guard guessing an id.
      const employee = await tx.employee.findFirst({
        where: { userId: user.id, deletedAt: null },
        select: { id: true },
      });
      const ctx: AuthContext = {
        sessionId: resolved.sessionId,
        userId: user.id,
        companyId: resolved.companyId,
        roleId: role.id,
        roleKey: role.key,
        permissions: permissionsForRole(role.key),
        clientType,
        callerEmployeeId: employee?.id ?? null,
      };
      return ctx;
    });

    if (!authContext) {
      throw new UnauthorizedException();
    }

    request.authContext = authContext;
    return true;
  }
}

function extractToken(request: Request): { token: string | null; clientType: 'web' | 'mobile' } {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return { token: authorization.slice('Bearer '.length).trim() || null, clientType: 'mobile' };
  }
  const cookieToken = request.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  return { token: cookieToken ?? null, clientType: 'web' };
}
