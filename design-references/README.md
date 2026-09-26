# design-references/

## What this folder is for

Visual reference material — mockups and screenshots used while building the interface.
Reference only; nothing here is shipped or imported.

## What it contains

Image files. The written design specification lives in
[`../product-documentation/`](../product-documentation/README.md) (DOCUMENTS 10 and 11), and
the implemented design system lives in `packages/design-tokens` and
`apps/web/src/components/design-system.tsx`.

## Which part of the system uses it

People, while building a screen. No build step reads this folder.

## Important rules and dependencies

- A reference image is **not** a specification. Where an image and a DOCUMENT disagree, the
  document wins, and the disagreement is worth raising (DOCUMENT 27 RULE 35).
- Application assets that actually ship belong with the application that serves them, not
  here.

## Should developers add files here?

Add reference images. Do not import from here in application code.
