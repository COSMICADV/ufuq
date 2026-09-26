/**
 * `/api/v1/auth/*` — DOCUMENT 08 §4.1.
 *
 * Every response uses the DOCUMENT 08 §2 envelope. Web login/logout/refresh
 * of the session happen through cookies the browser sends automatically;
 * the response body never repeats a session token back to a web caller
 * (DOCUMENT 20 §8) — only a mobile caller, which has nowhere else to keep
 * one, receives tokens in the body.
 */

import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';
import type { Env } from '@ufuq/config';
import { withTenant } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';
import type { Request, Response } from 'express';

import { APP_ENV } from '../app.tokens.js';
import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';
import { PRISMA_CLIENT } from '../common/db.tokens.js';

import { AuthService } from './auth.service.js';
import type { AuthContext } from './auth-context.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { AcceptInvitationDto } from './dto/accept-invitation.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { InvitationPreviewDto } from './dto/invitation-preview.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { ChangePasswordDto } from './dto/change-password.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { LoginDto } from './dto/login.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { RefreshDto } from './dto/refresh.dto.js';
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- NestJS reads this class via emitDecoratorMetadata at runtime; `import type` would erase it from `design:paramtypes`.
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { clearSessionCookies, setSessionCookies } from './cookies.js';

interface UserPayload {
  readonly id: string;
  readonly email: string;
}

interface LoginResponsePayload {
  readonly user: UserPayload;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

/** DOCUMENT 04 A4 — read-only, and nothing beyond what that screen displays. */
interface InvitationPreviewPayload {
  readonly company_name: string;
  readonly employee_name: string | null;
}

interface RefreshResponsePayload {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function requestContext(request: Request): { ipAddress: string | null; userAgent: string | null } {
  return { ipAddress: request.ip ?? null, userAgent: request.headers['user-agent'] ?? null };
}

function clientTypeOf(request: Request): 'web' | 'mobile' {
  return request.headers['x-client-type'] === 'mobile' ? 'mobile' : 'web';
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<LoginResponsePayload>> {
    const clientType = clientTypeOf(request);
    const { user, session } = await this.auth.login(
      dto.email,
      dto.password,
      dto.rememberMe ?? false,
      clientType,
      requestContext(request),
    );

    if (clientType === 'web') {
      setSessionCookies(response, this.env, session.token, session.expiresAt);
      return single({ user: { id: user.id, email: user.email } }, { locale });
    }
    return single(
      {
        user: { id: user.id, email: user.email },
        accessToken: session.token,
        // `session.refreshToken` is always set here — `clientType === 'mobile'`
        // is exactly the condition `SessionService.create` uses to decide
        // whether to mint one.
        ...(session.refreshToken !== null ? { refreshToken: session.refreshToken } : {}),
      },
      { locale },
    );
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @CurrentUser() ctx: AuthContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, never>>> {
    await this.auth.logout(ctx.companyId, ctx.userId, ctx.sessionId, requestContext(request));
    if (ctx.clientType === 'web') {
      clearSessionCookies(response);
    }
    return single({}, { locale });
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() request: Request,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, never>>> {
    // DOCUMENT 08 §4.1: always 200, always this same body, whatever happened internally.
    await this.auth.forgotPassword(dto.email, requestContext(request));
    return single({}, { locale });
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, never>>> {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return single({}, { locale });
  }

  /**
   * DOCUMENT 04 A4 — the company and employee name shown read-only on the
   * acceptance page. Does not redeem the token; the invitee still has to post
   * it to `accept-invitation` with a password.
   */
  @Public()
  @Post('invitation-preview')
  @HttpCode(200)
  async previewInvitation(
    @Body() dto: InvitationPreviewDto,
    @Req() request: Request,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<InvitationPreviewPayload>> {
    const preview = await this.auth.previewInvitation(dto.token, request.ip ?? null);
    return single(
      { company_name: preview.companyName, employee_name: preview.employeeName },
      { locale },
    );
  }

  @Public()
  @Post('accept-invitation')
  @HttpCode(200)
  async acceptInvitation(
    @Body() dto: AcceptInvitationDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, never>>> {
    await this.auth.acceptInvitation(dto.token, dto.password);
    return single({}, { locale });
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() ctx: AuthContext,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<Record<string, never>>> {
    await this.auth.changePassword(
      { companyId: ctx.companyId, userId: ctx.userId, sessionId: ctx.sessionId },
      dto.currentPassword,
      dto.newPassword,
      requestContext(request),
    );
    return single({}, { locale });
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() dto: RefreshDto,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<RefreshResponsePayload>> {
    const rotated = await this.auth.refresh(dto.refreshToken);
    // `rotateForRefresh` only ever produces a mobile session (web sessions
    // have no refresh token to rotate — see SessionService.create), so
    // `refreshToken` is always present here.
    return single(
      { accessToken: rotated.token, refreshToken: rotated.refreshToken as string },
      { locale },
    );
  }

  @Get('me')
  async me(
    @CurrentUser() ctx: AuthContext,
    @RequestLocale() locale: Locale,
  ): Promise<SingleResponse<unknown>> {
    const payload = await withTenant(this.prisma, ctx.companyId, async (tx) => {
      const [user, company, role, employee] = await Promise.all([
        tx.user.findUniqueOrThrow({ where: { id: ctx.userId } }),
        tx.company.findUniqueOrThrow({ where: { id: ctx.companyId } }),
        tx.role.findUniqueOrThrow({ where: { id: ctx.roleId } }),
        ctx.callerEmployeeId === null
          ? null
          : tx.employee.findUnique({
              where: { id: ctx.callerEmployeeId },
              select: {
                id: true,
                employeeCode: true,
                firstName: true,
                lastName: true,
                departmentId: true,
                positionId: true,
                managerId: true,
                status: true,
              },
            }),
      ]);
      return {
        user: {
          id: user.id,
          email: user.email,
          locale: user.locale,
          status: user.status,
        },
        company: {
          id: company.id,
          name: company.name,
          slug: company.slug,
          timezone: company.timezone,
          currency: company.currency,
          defaultLocale: company.defaultLocale,
          // DOCUMENT 12 rule 13 — every authenticated user needs it, not just
          // an administrator: it decides whether the attendance history offers
          // a correction for a given day (DOCUMENT 04 C3).
          correctionWindowDays: company.correctionWindowDays,
        },
        role: { id: role.id, key: role.key, nameEn: role.nameEn, nameAr: role.nameAr },
        permissions: Array.from(ctx.permissions.entries()).map(([key, scope]) => ({ key, scope })),
        // DOCUMENT 08 §4.1 — "user, employee, role, permissions, company
        // settings". Null for a user with no employee record (the seeded
        // first admin). snake_case, per DOCUMENT 08 §1, like every payload
        // since Phase 4.
        employee:
          employee === null
            ? null
            : {
                id: employee.id,
                employee_code: employee.employeeCode,
                first_name: employee.firstName,
                last_name: employee.lastName,
                department_id: employee.departmentId,
                position_id: employee.positionId,
                manager_id: employee.managerId,
                status: employee.status,
              },
      };
    });
    return single(payload, { locale });
  }
}
