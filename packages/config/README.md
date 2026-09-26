# packages/config (`@ufuq/config`)

## What this folder is for

Reading and validating the environment **once**, at startup, and refusing to boot on a bad
one. A missing database URL should stop the process immediately, not surface as a confusing
error on the first request.

## What it contains

`env.ts` — the schema for every environment variable the system reads, its parsing, and its
validation. `index.ts` re-exports it.

## Which part of the system uses it

`apps/api` at boot, and `scripts/verify-foundation.mjs`.

## Important rules and dependencies

- **Variable names are a deployment contract.** Renaming one silently breaks every
  environment that sets it; a rename needs a migration plan, not a tidy-up.
- Secrets are read here and never logged. `SMTP_PASSWORD` is marked as a secret key.
- `.env.example` at the repository root is the documented list — keep the two in step.

## Should developers add files here?

Add a variable when a new integration genuinely needs one, with its validation, and update
`.env.example` in the same change. Do not read `process.env` anywhere else.
