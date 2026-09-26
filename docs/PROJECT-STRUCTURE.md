# Project structure

Where everything lives, and why it lives there. Written after the repository was
consolidated into a single canonical project folder, `ufuq-main`.

## The two top-level folders

```
أُفق/
├── ufuq-main/     ← the project. Everything that is built, tested or shipped
└── archive/       ← superseded copies, kept but not part of the project
```

`archive/` is inert: nothing builds it, nothing imports it, and nothing in `ufuq-main`
refers to it. See [`../../archive/README.md`](../../archive/README.md) for what is in it and
why.

## The project

```
ufuq-main/
├── apps/                          Deployable applications (product surfaces)
│   ├── api/                       NestJS REST API — /api/v1. The only writer to the database
│   │   ├── src/
│   │   │   ├── attendance/        Phase 6 — check-in/out, calculation engine, corrections, nightly job
│   │   │   ├── auth/              Sessions, login, invitations, permission guards, audit writer
│   │   │   ├── common/            Response envelope, error filter, validation pipe, DI tokens
│   │   │   ├── company-structure/ Phase 4 — settings, departments, positions, schedules, holidays
│   │   │   ├── employees/         Phase 5 — employee CRUD, activation, invitations
│   │   │   ├── health/            GET /api/v1/health
│   │   │   └── mail/              SMTP transport and the invitation message
│   │   └── test/                  End-to-end suites (real Nest, real guards, real PostgreSQL)
│   ├── web/                       Next.js — admin and employee screens
│   │   └── src/
│   │       ├── app/[locale]/      Routes. Every page sits under a locale segment
│   │       ├── components/        Screens by feature, plus the design system
│   │       ├── lib/               Pure logic worth testing without rendering
│   │       └── styles/            globals.css — the single stylesheet
│   └── mobile/                    Expo — the employee mobile client
│
├── packages/                      Shared libraries (@ufuq/*)
│   ├── auth/                      Permissions, roles, scopes, password policy, hashing
│   ├── config/                    Environment loading and validation
│   ├── db/                        Prisma schema, migrations, tenant-scoped client, seed
│   ├── design-tokens/             DOCUMENT 10 tokens as CSS variables
│   ├── eslint-config/             Shared lint rules, incl. architecture boundaries
│   ├── i18n/                      Locales, direction, Arabic + English catalogues
│   ├── money/                     Exact decimal arithmetic for money and stock
│   └── tsconfig/                  Shared TypeScript configuration
│
├── docs/                          What this repository has built, phase by phase
├── product-documentation/         The specification — the numbered DOCUMENT set
├── design-references/             Visual reference images
├── scripts/                       Repository-level automation (pnpm verify)
│
├── package.json                   Workspace root scripts
├── pnpm-workspace.yaml            Workspace globs: apps/*, packages/*
├── turbo.json                     Task graph and caching
├── tsconfig.base.json             Compiler options the whole monorepo shares
├── eslint.config.mjs              Root lint entry, extends @ufuq/eslint-config
├── docker-compose.yml             Local PostgreSQL, Redis, MinIO, Mailpit
└── .env.example                   The documented environment contract
```

Every folder above has a `README.md` describing what it is for, what it holds, who uses it,
the rules that apply, and whether new files belong there.

## Why it is arranged this way

**Applications and packages are separated by dependency direction, not by taste.** An
application may import a package; a package may never import an application. The rule is not
a convention — `packages/eslint-config/boundaries.mjs` makes a violation fail the build.

**A package exists when logic must have exactly one home.** `@ufuq/auth` holds the
permission catalogue because a permission key hard-coded in two places is two keys.
`@ufuq/money` exists because money must never touch binary floating point. `@ufuq/i18n`
exists so Arabic and English cannot drift apart between surfaces.

**Specification and record are kept apart.** `product-documentation/` says what the product
should be; `docs/` says what has been built and what was decided along the way. Collapsing
them would lose the distinction between a requirement and a report.

**Feature folders inside `apps/api/src` are modules, not layers.** Everything attendance
needs sits in `attendance/` — controller, service, DTOs, the calculation engine — rather
than being scattered across `controllers/`, `services/` and `dtos/`. A phase is then added
or read in one place.

## Names that are deliberately not "clearer"

Some names look like abbreviations or jargon and are load-bearing. Renaming any of them
would break a framework convention, a deployment contract, or hundreds of code comments.

| Name                                                                                         | Why it stays                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps`, `packages`, `src`, `test`, `prisma`, `migrations`                                    | Ecosystem conventions that tooling and `pnpm-workspace.yaml` resolve by name       |
| `apps/web/src/proxy.ts`                                                                      | A **Next.js file convention**. Renamed, locale redirection stops running           |
| `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.dto.ts`, `*.guard.ts`, `*.decorator.ts` | NestJS conventions                                                                 |
| `*.tokens.ts`                                                                                | Dependency-injection token files — the established name in this codebase           |
| `apps/web/src/app/[locale]/`                                                                 | A Next.js dynamic segment. The brackets are syntax                                 |
| `packages/db` (not `packages/database`)                                                      | The package is published as `@ufuq/db` and imported by that name everywhere        |
| `i18n`                                                                                       | The universal name for this concern; "internationalisation" would be worse         |
| `scripts/verify-foundation.mjs`                                                              | "Foundation" is DOCUMENT 25's own word for Phase 1 and for the criterion it checks |
| `scripts/lib/`                                                                               | Conventional, and referenced by the script beside it                               |
| Migration folder names (`20260923000000_phase6_attendance`)                                  | Prisma resolves migrations by name and records them in the database                |
| Database tables, columns, API routes, environment variables                                  | Contracts with the database, clients and every deployment                          |

## What was renamed

| Before                          | After                              | Why it was safe                                                                           |
| ------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `files 2/ufuq active codebase/` | `ufuq-main/`                       | A folder name with spaces, describing itself as "active"                                  |
| `product documentation/`        | `ufuq-main/product-documentation/` | The space broke shell paths; no code referenced it                                        |
| `design/`                       | `ufuq-main/design-references/`     | Says what it holds; nothing imported it                                                   |
| `apps/api/test/migrations.ts`   | `apps/api/test/all-migrations.ts`  | It loads _all_ migration SQL; it does not contain migrations. Four importers, all updated |

## Adding a new phase

1. Read the DOCUMENT 25 entry for the phase and the specifications it names.
2. Add models to `packages/db/prisma/schema.prisma` and **one new migration folder** —
   never edit an applied migration.
3. Add the feature module under `apps/api/src/<feature>/`.
4. Add screens under `apps/web/src/app/[locale]/` and `apps/web/src/components/<feature>/`.
5. Add strings to **both** catalogues in `packages/i18n/src/locales/`.
6. Write `docs/PHASE-<n>-STATUS.md`, and mark it complete only when the exit criterion
   passes.
