# packages/money (`@ufuq/money`)

## What this folder is for

Exact arithmetic for money and stock quantities. DOCUMENT 27 RULE 17 and NFR-04: these are
fixed-precision decimals, and binary floating point is not permitted anywhere near them.

## What it contains

`src/decimal.ts` — the decimal type and its operations. `src/money.ts` — the money-specific
layer on top. `src/money.test.ts` — the arithmetic proofs.

## Which part of the system uses it

`apps/api` wherever a monetary or stock value is computed. Payroll (Phase 11) and inventory
(Phase 13) are its main consumers.

## Important rules and dependencies

- **Rounding happens once, at the end**, per the configured policy — never in the middle of
  a calculation.
- `Math.round`, `.toFixed()` and `parseFloat` are lint errors workspace-wide, which is what
  makes using this package the path of least resistance.
- A duration in minutes is a count of clock ticks, not money, and does not belong here.

## Should developers add files here?

Add an operation when a real calculation needs it, with tests that state the precision
expectation. Do not add a "close enough" helper.
