/**
 * PrismaClient construction.
 *
 * The connection string is passed in rather than read from `process.env`
 * here, matching how `apps/api` treats every other credential (DOCUMENT 20
 * §11): `@ufuq/config` validates it once at bootstrap, and every consumer
 * receives an already-validated value instead of reading the environment a
 * second time.
 */

import { PrismaClient } from '@prisma/client';

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
