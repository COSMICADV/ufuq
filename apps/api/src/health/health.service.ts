/**
 * Health check — DOCUMENT 25 Phase 1.
 *
 * It reports what the process itself can answer without reaching a dependency:
 * the service is up, which build it is, and which environment it believes it is
 * running in. Dependency probes (database, Redis, storage) belong to the phases
 * that introduce those dependencies, and a check that claims to test a
 * connection it never opens is worse than no check.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { APP_ENV, APP_INFO } from '../app.tokens.js';
import type { AppInfo } from '../app.tokens.js';

export interface HealthPayload {
  readonly status: 'ok';
  readonly service: string;
  readonly version: string;
  readonly environment: Env['nodeEnv'];
  /** The status in the caller's language (DOCUMENT 27 RULE 25). */
  readonly message: string;
  /** ISO 8601, UTC in transport (DOCUMENT 08 §1). */
  readonly time: string;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_ENV) private readonly env: Env,
    @Inject(APP_INFO) private readonly info: AppInfo,
  ) {}

  read(locale: Locale, now: Date = new Date()): HealthPayload {
    return {
      status: 'ok',
      service: this.info.name,
      version: this.info.version,
      environment: this.env.nodeEnv,
      message: createTranslator(locale)('health.ok'),
      time: now.toISOString(),
    };
  }
}
