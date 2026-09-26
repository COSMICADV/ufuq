import { Controller, Get, Inject } from '@nestjs/common';
import type { Locale } from '@ufuq/i18n';

import { single } from '../common/envelope.js';
import type { SingleResponse } from '../common/envelope.js';
import { RequestLocale } from '../common/request-locale.js';
import { Public } from '../auth/decorators/public.decorator.js';
import { HealthService } from './health.service.js';
import type { HealthPayload } from './health.service.js';

/**
 * `GET /api/v1/health`.
 *
 * It takes no input, so there is nothing to validate (DOCUMENT 08 §5) and no
 * tenant to scope (DOCUMENT 27 RULE 10). It is deliberately unauthenticated:
 * a liveness probe that needs a session cannot report that sessions are broken.
 * `@Public()` is what makes that true now that `SessionAuthGuard` applies to
 * every route by default (Phase 3, DOCUMENT 27 RULE 29).
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  @Public()
  @Get()
  read(@RequestLocale() locale: Locale): SingleResponse<HealthPayload> {
    return single(this.health.read(locale), { locale });
  }
}
