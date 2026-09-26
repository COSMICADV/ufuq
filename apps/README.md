# apps/

## What this folder is for

The three deployable applications. Everything here is a _product surface_ — something a
person or another system talks to. Reusable logic does not live here; it lives in
[`../packages/`](../packages/README.md).

`pnpm-workspace.yaml` includes `apps/*`, so each application is part of the build, lint,
typecheck and test graph.

## What it contains

| Application                   | Stack                            | Purpose                                           |
| ----------------------------- | -------------------------------- | ------------------------------------------------- |
| [`api/`](api/README.md)       | NestJS + TypeScript              | The REST API at `/api/v1` (DOCUMENT 08)           |
| [`web/`](web/README.md)       | Next.js + React + TypeScript     | Admin and employee screens (DOCUMENTS 03, 04, 23) |
| [`mobile/`](mobile/README.md) | Expo + React Native + TypeScript | The employee mobile client (DOCUMENT 22)          |

The stack was approved as `AP-00`; see [`../docs/PHASE-1-STATUS.md`](../docs/PHASE-1-STATUS.md).

## Which part of the system uses it

Nothing imports an application — applications are the leaves of the dependency graph.
They import the shared packages; the packages never import back. The ESLint boundary rule
in `@ufuq/eslint-config` enforces that direction.

## Important rules and dependencies

- **Business rules belong in one place** (DOCUMENT 27 RULES 6 and 7). If `api` and `web`
  both need a rule, it is the API's rule and the web screen asks for the answer — the web
  app never re-implements a calculation to avoid a round trip.
- **The web and mobile clients never enforce permissions.** They decide what to _render_;
  the API decides what is _allowed_ (DOCUMENT 27 RULES 8 and 9).
- Every application depends on `@ufuq/i18n` for locale and direction, so Arabic and
  English cannot drift apart between surfaces.

## Should developers add files here?

Add a new file here when it belongs to one application only — a screen, a controller, a
module. If two applications would need it, it belongs in `packages/`. Adding a fourth
application is an architecture change (DOCUMENT 27 RULE 1) and needs a decision first.
