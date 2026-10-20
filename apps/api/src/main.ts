/**
 * API bootstrap.
 *
 * Order matters: the environment is validated before anything else is
 * constructed, so a misconfigured process fails at startup with every problem
 * listed at once rather than at the first request that needs the missing value.
 */

import 'reflect-metadata';

import { readFile } from 'node:fs/promises';

import cookieParser from 'cookie-parser';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EnvError, loadEnv } from '@ufuq/config';

import { AppModule } from './app.module.js';
import { API_PREFIX } from './api-prefix.js';
import type { AppInfo } from './app.tokens.js';
import { createValidationPipe } from './common/validation-pipe.js';
import { ErrorFilter } from './common/error.filter.js';
import { notFoundHandler } from './common/not-found.js';
import { corsOptions } from './cors.js';

export { API_PREFIX };

async function readAppInfo(): Promise<AppInfo> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(manifest) as { name?: string; version?: string };
  return { name: 'ufuq-api', version: parsed.version ?? '0.0.0' };
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const env = loadEnv();
  const info = await readAppInfo();

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env, info));

  // Behind a hosting provider's proxy (and the web app's same-origin rewrite)
  // every request otherwise comes from the proxy's address, which would merge
  // all clients into one login rate-limit bucket. Opt-in; see TRUST_PROXY_HOPS.
  if (env.trustProxyHops) {
    app.set('trust proxy', env.trustProxyHops);
  }

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalPipes(createValidationPipe());
  // Reads the httpOnly session cookie (DOCUMENT 09 §3) and the non-httpOnly
  // CSRF cookie (DOCUMENT 20 §6) into `request.cookies` for SessionAuthGuard
  // and CsrfGuard. No secret is signed here — the cookie's own value is
  // already an unguessable opaque token; a signing secret would protect
  // against a threat (a forged cookie *value*) this design does not have.
  app.use(cookieParser());

  // OD-02: one allowed origin, with credentials, and the headers a screen
  // reads exposed (see cors.ts).
  app.enableCors(corsOptions(env.webOrigin));

  // Routes are registered during init, so the fallback has to be added after
  // it — otherwise it would answer before the controllers ever ran.
  await app.init();
  app.getHttpAdapter().getInstance().use(notFoundHandler);

  await app.listen(env.apiPort);

  logger.log(
    `${info.name} ${info.version} listening on :${env.apiPort}/${API_PREFIX} (${env.nodeEnv})`,
  );
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  if (error instanceof EnvError) {
    // The message already lists every problem; a stack trace adds nothing and
    // the values themselves must not be printed (DOCUMENT 20 §8).
    logger.error(error.message);
  } else {
    logger.error('The API failed to start.', error instanceof Error ? error.stack : String(error));
  }
  process.exitCode = 1;
});
