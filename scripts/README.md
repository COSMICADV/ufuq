# scripts/

## What this folder is for

Repository-level automation that is not part of any single workspace's build.

## What it contains

| File                    | Does                                                                   |
| ----------------------- | ---------------------------------------------------------------------- |
| `verify-foundation.mjs` | End-to-end verification of the DOCUMENT 25 Phase 1 exit criterion      |
| `lib/servers.mjs`       | Starting and stopping the built applications, used by the script above |

`verify-foundation.mjs` boots the built API and web application, checks that configuration
loads, that the locale layer switches language _and_ direction both ways, that decimal
arithmetic is exact, and that the applications answer in Arabic and English. It is wired to
`pnpm verify`.

The name keeps the word **foundation** because that is DOCUMENT 25's own name for Phase 1
and for the criterion this script checks. A more generic name would read better and mean
less.

## Which part of the system uses it

`package.json` (`pnpm verify`) and CI.

## Important rules and dependencies

- `pnpm verify` needs `pnpm build` first — it starts the _built_ applications — and, since
  Phase 3, a running database and Redis (`pnpm infra:up`, `pnpm db:setup`), because the API
  opens a real connection at boot.
- These scripts are plain Node ESM (`.mjs`) with no build step, so they run before anything
  is compiled.

## Should developers add files here?

Add a script when a task spans the whole repository. A task belonging to one workspace
belongs in that workspace's `package.json`.
