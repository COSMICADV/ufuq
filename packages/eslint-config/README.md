# packages/eslint-config (`@ufuq/eslint-config`)

## What this folder is for

The shared lint configuration — including the two rule sets that make architectural
decisions fail the build rather than rely on review.

## What it contains

| File                 | Holds                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `index.mjs`          | The base TypeScript and style rules every workspace extends                   |
| `boundaries.mjs`     | Dependency direction — an application may import a package, never the reverse |
| `decimal-safety.mjs` | `Math.round`, `.toFixed()` and `parseFloat` are errors (DOCUMENT 27 RULE 17)  |

## Which part of the system uses it

Every workspace, through its own `eslint.config.mjs`.

## Important rules and dependencies

- `decimal-safety.mjs` exists because money and stock are fixed-precision decimals and
  binary floating point silently loses money. Where a count genuinely is not money — whole
  minutes of attendance, for instance — the escape is a single named helper with the reason
  written down, not a disable comment scattered at each call site.
- Loosening a rule here loosens it everywhere. That is the point, and the reason a change
  needs justifying.

## Should developers add files here?

Add a rule when a mistake has been made twice and could be caught mechanically. Removing or
weakening a rule is an architecture decision (RULE 1).
