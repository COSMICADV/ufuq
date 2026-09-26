/**
 * Every Prisma migration, in the order `prisma migrate deploy` applies them.
 *
 * An e2e suite boots the whole application, and the whole application reads
 * every table — Phase 5's session guard, for one, looks up the caller's
 * employee record on every request. A suite that loaded only "its own" phase's
 * migration would test a schema no deployment has. Reading the directory
 * rather than naming files means a new phase's migration is picked up by every
 * suite without anyone remembering to add it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../packages/db/prisma/migrations/', import.meta.url),
);

export function allMigrationsSql(): string {
  return (
    readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Prisma's directory names start with a UTC timestamp, so name order is
      // application order.
      .sort()
      .map((name) =>
        readFileSync(
          fileURLToPath(new URL(`${name}/migration.sql`, `file://${MIGRATIONS_DIRECTORY}`)),
          'utf8',
        ),
      )
      .join('\n')
  );
}
