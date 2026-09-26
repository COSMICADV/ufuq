# packages/auth (`@ufuq/auth`)

## What this folder is for

Everything that decides **who someone is and what they may do** — expressed once, as data
and pure functions, so the API and the clients cannot disagree about it.

## What it contains

| File                    | Holds                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| `permissions.ts`        | The DOCUMENT 02 permission catalogue — every key in the system             |
| `roles.ts`              | The four system roles and the permissions each one grants, with its scope  |
| `scope.ts`              | Resolving `self` / `team` / `company` / `platform` into a query constraint |
| `password-policy.ts`    | Minimum length and the breach check (DOCUMENT 09 §2)                       |
| `breached-passwords.ts` | The refused-password list the policy consults                              |
| `crypto.ts`             | Argon2 hashing, opaque token generation and hashing                        |
| `session-policy.ts`     | Session lifetimes, lockout thresholds, rate-limit budgets, token TTLs      |

## Which part of the system uses it

`apps/api` for every authorization decision; `apps/web` only to pin its copies of shared
constants to the source in tests.

## Important rules and dependencies

- **This package decides nothing at runtime about a specific request.** It describes the
  rules; `apps/api` applies them with the caller's context. That split is what makes the
  rules testable without a database.
- A permission key added here must also be seeded (`packages/db/prisma/seed.ts`) and granted
  to a role, or it exists and reaches nobody.
- `super_admin` is never assignable through the API (DOCUMENT 02 §7).

## Should developers add files here?

Yes — a new permission key or a change to a role's grants belongs here and nowhere else.
Never hard-code a permission string in an application; import it.
