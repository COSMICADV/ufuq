# أُفق (Ufuq) — ERP monorepo

Arabic-first ERP for Arabic-speaking SMEs. Functional phases through
**Phase 16 — Public Website** are complete. See
[`docs/PHASE-16-STATUS.md`](docs/PHASE-16-STATUS.md) for the current implementation,
verification results and deployment configuration. The final visual redesign,
Phase 17 and deployment have not started.

Read the relevant status documents in [`docs/`](docs/README.md) before changing
an existing module. [`docs/PROJECT-STRUCTURE.md`](docs/PROJECT-STRUCTURE.md)
explains the repository layout.

Local mail: invitation/registration activation and public contact mail reuse SMTP.
`pnpm infra:up` starts Mailpit, which accepts local messages without delivering them
externally; inspect messages at `http://localhost:8025`. `CONTACT_TO` configures the
contact recipient. This does not enable an email notification channel.

## Stack

| Layer        | Choice                              |
| ------------ | ----------------------------------- |
| Web          | Next.js + React + TypeScript        |
| API          | NestJS + TypeScript, REST `/api/v1` |
| Mobile       | React Native + Expo + TypeScript    |
| Database     | PostgreSQL + Prisma, RLS (Phase 3)  |
| Architecture | Modular monolith                    |
| Monorepo     | pnpm workspaces + Turborepo         |

## Requirements

| Tool    | Version                                |
| ------- | -------------------------------------- |
| Node.js | 22 or newer (`.nvmrc`)                 |
| pnpm    | 9 (via Corepack)                       |
| Docker  | for local PostgreSQL, Redis, and MinIO |

## Setup

```bash
corepack enable                # makes pnpm 9 available
pnpm install
cp .env.example .env
pnpm infra:up                  # PostgreSQL, Redis, MinIO
pnpm db:setup                  # migrate, then seed permissions/roles + a demo login
pnpm build
pnpm verify
```

`pnpm verify` needs `pnpm build` first — it starts the built applications — and,
since Phase 3, it also needs `pnpm infra:up` and `pnpm db:setup`: unlike Phase 1,
the API now opens a real database connection at boot.

`pnpm db:setup` seeds the DOCUMENT 02 permission catalogue and system roles
(every environment needs these) and, outside `NODE_ENV=production`, a demo
company with an ADMIN login — see `packages/db/prisma/seed.ts` for both the
local demo credentials. Real companies now register at `/register`; production still
seeds reference roles and permissions but never the demo company.

## Running the applications

| Application | Command                          | Where it listens                                          |
| ----------- | -------------------------------- | --------------------------------------------------------- |
| API         | `pnpm --filter @ufuq/api dev`    | `http://localhost:4000/api/v1` (`API_PORT`)               |
| Web         | `pnpm --filter @ufuq/web dev`    | `http://localhost:3000` — Arabic at `/`, English at `/en` |
| Mobile      | `pnpm --filter @ufuq/mobile dev` | Expo dev server; open in Expo Go or a development build   |

`@ufuq/api` runs its compiled output, so build it once before `dev`:

```bash
pnpm --filter @ufuq/api build
pnpm --filter @ufuq/api dev        # node --watch dist/main.js
```

The API refuses to start without a valid environment. Copy `.env.example` to
`.env`, or export the same variables, before running it.

Check it is alive:

```bash
curl -H 'Accept-Language: ar' http://localhost:4000/api/v1/health
curl -H 'Accept-Language: en' http://localhost:4000/api/v1/health
```

## Commands

| Command                                        | Purpose                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm build`                                   | Build every workspace package and application                          |
| `pnpm typecheck`                               | TypeScript, strict, no emit                                            |
| `pnpm lint`                                    | ESLint, including decimal-safety and boundary rules                    |
| `pnpm test`                                    | Unit tests (Vitest)                                                    |
| `pnpm format` / `pnpm format:check`            | Prettier                                                               |
| `pnpm verify`                                  | Phase 1 checks — config, locale, decimals, and a real application boot |
| `pnpm --filter @ufuq/mobile run bundle:check`  | Bundle the Expo application through Metro                              |
| `pnpm infra:up` / `infra:down` / `infra:reset` | Local infrastructure (`reset` drops volumes)                           |
| `pnpm db:migrate` / `db:seed` / `db:setup`     | Apply Prisma migrations / seed reference data / both, in order         |
| `pnpm clean`                                   | Remove build output and installed dependencies                         |

Local service ports: PostgreSQL `5432`, Redis `6379`, MinIO API `9000`, MinIO
console `9001`.

## Project folder map

Every folder below has its own `README.md` explaining what it is for, what it holds, who
uses it, the rules that apply, and whether new files belong there.
[`docs/PROJECT-STRUCTURE.md`](docs/PROJECT-STRUCTURE.md) has the full tree and the reasoning.

```
ufuq-main/
├── apps/                       Deployable applications — the product surfaces
│   ├── api/                    NestJS REST API (/api/v1). The only writer to the database
│   ├── web/                    Next.js — admin and employee screens, RTL/LTR
│   └── mobile/                 Expo + React Native — the employee mobile client
│
├── packages/                   Shared libraries, published internally as @ufuq/*
│   ├── auth/                   Permission catalogue, roles, scope resolution, password/token crypto
│   ├── config/                 Environment validation, fail-fast, secrets redacted
│   ├── db/                     Prisma schema, migrations, RLS policies, tenant-context helpers
│   ├── design-tokens/          DOCUMENT 10 design tokens as CSS variables
│   ├── eslint-config/          Base rules + decimal safety + module boundaries
│   ├── i18n/                   Locales, direction, message catalogues, formatters
│   ├── money/                  Fixed-precision Decimal, Money, Quantity, rounding policies
│   └── tsconfig/               Shared TypeScript configuration
│
├── docs/                       What this repository has built — phase status and decisions
├── product-documentation/      The specification — the numbered DOCUMENT set
├── design-references/          Visual reference images
├── scripts/                    Repository automation (pnpm verify)
│
├── docker-compose.yml          Local PostgreSQL, Redis, MinIO, Mailpit
├── pnpm-workspace.yaml         Workspace globs: apps/*, packages/*
├── turbo.json                  Task graph and caching
├── tsconfig.base.json          Compiler options shared by the whole monorepo
└── .env.example                The documented environment contract
```

A sibling `archive/` folder sits **outside** this project. It holds superseded copies and is
not built, imported, linted or tested — see [`../archive/README.md`](../archive/README.md).

Several names look like jargon and are load-bearing: `apps/web/src/proxy.ts` is a Next.js
file convention, `packages/db` matches the published name `@ufuq/db`, and the NestJS
`*.service.ts` / `*.controller.ts` suffixes are resolved by the framework. They are listed,
with the reason each one stays, in
[`docs/PROJECT-STRUCTURE.md`](docs/PROJECT-STRUCTURE.md).

## The rules this repository is built under

Three constraints from the specification are enforced by tooling rather than by
convention, because convention does not survive a deadline:

**Money never touches a float.** `@ufuq/money` holds values as bigint minor
units at a fixed scale. It refuses a JavaScript `number` at construction,
refuses to drop decimal places silently, and refuses an inexact division unless
the caller names a rounding policy. ESLint blocks `parseFloat`, `.toFixed()`,
and `Math.round()` anywhere in the repository. DOCUMENT 27 RULE 17.

**Arabic is the default, not a translation layer.** `@ufuq/i18n` resolves
direction from locale in one place, ships both catalogues together so a missing
key fails a test rather than reaching a user, and formats decimal strings
without ever converting them to numbers. The web root layout, the API's
`Accept-Language` handling, and the mobile shell all read direction from that
one place. DOCUMENT 01 NFR-01, DOCUMENT 27 RULES 24 and 25.

**Dependencies point one way.** Applications may depend on packages. Packages
may not depend on applications, applications may not depend on each other, and
nobody deep-imports another package's internals. Enforced by ESLint. DOCUMENT 27
RULES 20 and 34.

## Before any coding session

Per DOCUMENT 27: read the development rules, read the specification for the
module being worked on, confirm the work is in DOCUMENT 24's scope, confirm
DOCUMENT 25 permits the phase now, and check DOCUMENT 28 for a blocking
decision. Raise `[DECISION REQUIRED]` before implementing, never after.
