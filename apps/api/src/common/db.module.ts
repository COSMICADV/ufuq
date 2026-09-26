/**
 * Database connection — AD-03.
 *
 * `PrismaClient` connects with `env.databaseUrl`, which is always the
 * `ufuq_app` connection string: the running API process never holds
 * migration-role credentials (DOCUMENT 20 §11). Row-level security is what
 * actually isolates one company's data from another; see `@ufuq/db`'s
 * `withTenant` for the only sanctioned way this module's client is queried.
 */

import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnModuleDestroy } from '@nestjs/common';
import type { Env } from '@ufuq/config';
import { createPrismaClient } from '@ufuq/db';
import type { PrismaClient } from '@ufuq/db';

import { PRISMA_CLIENT } from './db.tokens.js';

@Injectable()
class PrismaLifecycle implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaLifecycle.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
    this.logger.log('Database connection closed.');
  }
}

@Module({})
export class DbModule {
  static register(env: Env): DynamicModule {
    return {
      module: DbModule,
      global: true,
      providers: [
        { provide: PRISMA_CLIENT, useFactory: () => createPrismaClient(env.databaseUrl) },
        PrismaLifecycle,
      ],
      exports: [PRISMA_CLIENT],
    };
  }
}
