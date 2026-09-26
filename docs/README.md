# docs/

## What this folder is for

What **this repository** has actually built, phase by phase — as opposed to
[`../product-documentation/`](../product-documentation/README.md), which is what the product
is _specified_ to be.

Read the status document for a phase before touching that phase's code. Each one records
what is complete, which decisions were approved and why, what was deliberately not built,
and what is still open.

## What it contains

| File                   | Covers                                                          |
| ---------------------- | --------------------------------------------------------------- |
| `PROJECT-STRUCTURE.md` | The repository layout and why it is arranged this way           |
| `PHASE-1-STATUS.md`    | Foundation — repo, CI, config, localisation, health check       |
| `PHASE-3-STATUS.md`    | Authentication — users, roles, sessions, tenancy, row security  |
| `PHASE-4-STATUS.md`    | Company structure — settings, departments, positions, schedules |
| `PHASE-5-STATUS.md`    | Employees — CRUD, invitations, manager assignment               |
| `PHASE-6-STATUS.md`    | Attendance — check-in/out, the calculation engine, corrections  |

Phase 2 (design system) has no separate status document; its outcome is
`packages/design-tokens` and the component set in `apps/web/src/components/design-system.tsx`.

## Which part of the system uses it

People. Nothing imports these files.

## Important rules and dependencies

- A phase is complete only when its DOCUMENT 25 exit criterion **passes**, and the status
  document says how that was proved rather than asserting it.
- Open questions are recorded as `[DECISION REQUIRED]` rather than answered by guessing
  (DOCUMENT 27 RULE 35).

## Should developers add files here?

Add one status document per phase, named `PHASE-<n>-STATUS.md`. Update the existing one when
a later change alters what that phase delivered — do not let it drift into fiction.
