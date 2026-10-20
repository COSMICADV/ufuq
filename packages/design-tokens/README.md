# packages/design-tokens (`@ufuq/design-tokens`)

## What this folder is for

The UFUQ Visual Identity V2 design system as code: colours, spacing, radii, typography and shadows, as
CSS custom properties. One definition, so every surface shares the same navy/indigo identity.

## What it contains

`src/tokens.css` — the custom properties on `:root`. `src/index.ts` exposes the package
entry point.

## Which part of the system uses it

`apps/web` imports `tokens.css` at the top of `src/styles/globals.css`. Every rule in that
stylesheet refers to a token rather than a literal.

## Important rules and dependencies

- **No screen invents a colour or a font size** (DOCUMENT 27 RULES 21–23). If a screen needs
  a shade that does not exist, that is a design-system change, made here, once.
- Token names are referenced by string from CSS, so renaming one means finding every use.

## Should developers add files here?

Add a token when the design system genuinely gains one. Do not add a token that exists only
for a single screen — that is a local style, and usually a sign the screen should reuse an
existing component.

The final rules are documented in `docs/FINAL-UI-UX-REDESIGN.md`. Historical green/sage token names remain compatibility aliases with V2 values. CSS and TypeScript values serve web and native consumers; font-family names refer to externally hosted/installed fonts, never bundled binaries.
