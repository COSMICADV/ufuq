# packages/

## What this folder is for

Shared libraries. Everything here is imported by more than one application, or exists to
keep a rule in exactly one place (DOCUMENT 27 RULES 6 and 7).

`pnpm-workspace.yaml` includes `packages/*`; each is published internally as `@ufuq/<name>`.

## What it contains

| Package                                     | What it is                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| [`auth/`](auth/README.md)                   | Permissions, roles, scopes, password policy, hashing, session policy         |
| [`config/`](config/README.md)               | Environment loading and validation — fail fast on a bad environment          |
| [`db/`](db/README.md)                       | Prisma schema, migrations, the tenant-scoped client, id generation           |
| [`design-tokens/`](design-tokens/README.md) | The DOCUMENT 10 tokens as CSS variables                                      |
| [`eslint-config/`](eslint-config/README.md) | Shared lint rules, including the ones that enforce architecture              |
| [`i18n/`](i18n/README.md)                   | Locale, direction, the Arabic and English catalogues, date/number formatting |
| [`money/`](money/README.md)                 | Exact decimal arithmetic for money and stock                                 |
| [`tsconfig/`](tsconfig/README.md)           | Shared TypeScript configuration                                              |

## Which part of the system uses it

The applications in [`../apps/`](../apps/README.md), and other packages.

## Important rules and dependencies

- **Dependencies point one way**: applications depend on packages, packages depend on
  packages, and a package never imports an application. `@ufuq/eslint-config` enforces this
  as a build failure, not a convention.
- A package holds logic that is genuinely shared or genuinely a single source of truth.
  Code used by exactly one application belongs in that application.

## Should developers add files here?

Add to an existing package freely. Creating a _new_ package is an architecture decision
(RULE 1): say which applications need it and why the logic cannot live in an existing one.
