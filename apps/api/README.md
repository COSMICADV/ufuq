# apps/api

## What this folder is for

The REST API — the only thing that writes to the database, and the only place a business
rule is enforced. Every client (web, mobile, and anything later) goes through it.

Served under `/api/v1` (DOCUMENT 08 §1).

## What it contains

| Path                     | Holds                                                                        |
| ------------------------ | ---------------------------------------------------------------------------- |
| `src/auth/`              | Sessions, login, invitations, permissions guards, the audit writer           |
| `src/employees/`         | Phase 5 — employee CRUD, activation, invitation flow                         |
| `src/company-structure/` | Phase 4 — company settings, departments, positions, schedules, holidays      |
| `src/attendance/`        | Phase 6 — check-in/out, the calculation engine, corrections, the nightly job |
| `src/common/`            | The DOCUMENT 08 §2 envelope, error filter, validation pipe, DI tokens        |
| `src/health/`            | `GET /api/v1/health`                                                         |
| `src/mail/`              | SMTP transport and the invitation message                                    |
| `test/`                  | End-to-end suites — real Nest, real guards, real PostgreSQL (PGlite)         |

Within a feature folder the file suffixes are **NestJS conventions** and are not free to
change: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.dto.ts`, `*.guard.ts`,
`*.decorator.ts`. Files ending `.tokens.ts` hold dependency-injection tokens.

## Which part of the system uses it

`apps/web` and `apps/mobile` call it over HTTP. Nothing imports it as a library.

## Important rules and dependencies

- **Never trust a client `companyId`.** The tenant comes from the session, and every query
  runs through `withTenant` so PostgreSQL row-level security applies (DOCUMENT 27 RULES 10
  and 11).
- **Every endpoint validates its input and verifies authorization** (RULES 28 and 29).
- **Every important write is audited** with old and new values (RULE 18).
- **No working hours, salary rules or tax rules in code** (RULES 12 and 13) — they are
  configuration, read from the database.
- Money and stock never touch binary floating point; use `@ufuq/money` (RULE 17). A lint
  rule fails the build on `Math.round`, `toFixed` and `parseFloat`.

## Should developers add files here?

Yes — a new endpoint or business module belongs here, in its own feature folder with its
own module, controller, service and DTOs. Add the phase's migration to
`packages/db/prisma/migrations/` in the same change, and read the relevant DOCUMENT
before starting (RULE 4).
