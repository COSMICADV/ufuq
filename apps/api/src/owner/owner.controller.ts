import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { SignupRequestRow } from '@ufuq/db';
import type { Locale } from '@ufuq/i18n';

import { Public } from '../auth/decorators/public.decorator.js';
import { collection, single } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';
import { OwnerKeyGuard } from './owner-key.guard.js';
import { OwnerService } from './owner.service.js';

/** The JSON shape the owner page reads. */
function present(row: SignupRequestRow): Record<string, unknown> {
  return {
    company_id: row.companyId,
    company_name: row.companyName,
    employee_count_range: row.employeeCountRange,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    admin_name: row.adminName,
    admin_email: row.adminEmail,
    admin_phone: row.adminPhone,
  };
}

/**
 * The platform owner's sign-up review API. `@Public()` only means "no tenant
 * session": {@link OwnerKeyGuard} requires the owner key on every call.
 */
@Public()
@Controller('owner/signup-requests')
@UseGuards(OwnerKeyGuard)
export class OwnerController {
  constructor(@Inject(OwnerService) private readonly service: OwnerService) {}

  @Get()
  async index(@RequestLocale() locale: Locale): Promise<unknown> {
    const rows = await this.service.list();
    return collection(
      rows.map(present),
      rows.length,
      { page: 1, perPage: Math.max(1, rows.length) },
      { locale },
    );
  }

  @Post(':companyId/approve')
  @HttpCode(200)
  async approve(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @RequestLocale() locale: Locale,
  ): Promise<unknown> {
    return single(present(await this.service.decide(companyId, 'approve')), { locale });
  }

  @Post(':companyId/reject')
  @HttpCode(200)
  async reject(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @RequestLocale() locale: Locale,
  ): Promise<unknown> {
    return single(present(await this.service.decide(companyId, 'reject')), { locale });
  }
}
