# packages/db (`@ufuq/db`)

## What this folder is for

The database: the Prisma schema, every migration, and the only client the application is
allowed to use — one that binds the tenant before any query runs.

## What it contains

| Path                   | Holds                                                                            |
| ---------------------- | -------------------------------------------------------------------------------- |
| `prisma/schema.prisma` | Every model and enum in the system                                               |
| `prisma/migrations/`   | The applied migrations, one folder per phase, in timestamp order                 |
| `prisma/seed.ts`       | The permission catalogue, system roles, and a demo company outside production    |
| `src/tenant.ts`        | `withTenant` / `withPlatformContext` — the only routes to the database           |
| `src/auth-lookups.ts`  | The `SECURITY DEFINER` lookups that run before a tenant is known (login, tokens) |
| `src/id.ts`            | UUID v7 generation, so primary keys sort by creation time                        |
| `test/`                | Row-level-security suites — real PostgreSQL (PGlite), queries with no `WHERE`    |

## Which part of the system uses it

`apps/api` exclusively. No other application touches the database.

## Important rules and dependencies

- **Migrations are append-only.** Never edit one that has been written down; add a new one.
  Editing an applied migration is how two environments quietly stop sharing a schema.
- **Every migration explains its implications** — what data exists, what is in flight,
  whether it is reversible (DOCUMENT 27 RULE 31).
- **Table and column names are a contract.** They are not renamed for readability.
- **Row-level security is the enforcement, not the convention.** Every tenant table has
  `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy, and the suites in `test/`
  prove it against queries with no `WHERE` clause.
- A foreign key alone does not keep a reference inside one company — PostgreSQL checks keys
  without applying row security — so same-company triggers back the service checks.

## Should developers add files here?

Yes: a new phase adds its models to `schema.prisma` and **one new migration folder**. Run
`pnpm --filter @ufuq/db build` to regenerate the client afterwards.
