# packages/tsconfig (`@ufuq/tsconfig`)

## What this folder is for

The shared TypeScript configuration every workspace extends, so one strictness setting
applies everywhere instead of drifting per package.

## What it contains

The base `tsconfig` files. The repository root also has `tsconfig.base.json`, which sets the
compiler options the whole monorepo shares.

## Which part of the system uses it

Every application and package, through its own `tsconfig.json`.

## Important rules and dependencies

- Strictness is deliberate — `exactOptionalPropertyTypes` among others. Code is written to
  satisfy it rather than the setting relaxed to accept the code.
- Loosening an option here loosens it for the whole repository.

## Should developers add files here?

Rarely. A per-workspace override belongs in that workspace's own `tsconfig.json`.
