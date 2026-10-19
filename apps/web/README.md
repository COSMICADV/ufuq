# apps/web

## What this folder is for

The browser application: the public website, admin experience and employee experience
(DOCUMENTS 03 and 04). Next.js App Router.

## What it contains

| Path                     | Holds                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `src/app/[locale]/`      | Routes. Every page lives under a locale segment                                         |
| `src/components/`        | Screens, grouped by feature, plus the design system                                     |
| `src/lib/`               | Pure logic — the API client, and the parts of a screen worth testing                    |
| `src/styles/globals.css` | Product stylesheet; marketing uses `public.css`; tokens come from `@ufuq/design-tokens` |
| `src/proxy.ts`           | Locale routing and Arabic public rewrites. **Do not rename**                            |

## Which part of the system uses it

People. It calls `apps/api` over HTTP and imports nothing from it but shapes it declares
itself.

## Important rules and dependencies

- **Every UI route renders under `/{locale}` internally.** Arabic public URLs such as `/about` rewrite to `/ar/about`; English uses `/en/about`. The root layout reads that segment to set `lang`
  and `dir`; a route outside it would render in the wrong direction (RULE 24).
- **Arabic and English are both first-class** (RULE 25). Every string comes from
  `@ufuq/i18n` (including its bilingual `public-site.ts` content); the catalogue parity test fails if one language gains a key the other
  lacks.
- **Logical CSS properties only** — `inset-inline-start`, never `left`. The same stylesheet
  has to lay out both directions.
- **Design tokens only** — no hard-coded colours or font sizes (RULES 21–23).
- **Every screen handles loading, empty, error and success** (RULE 27).
- Permissions here decide what is _rendered_. The API decides what is _allowed_ (RULE 8).

## Should developers add files here?

Yes, for screens and browser-only logic. Put anything worth unit-testing in `src/lib/`
rather than inside a component, and reuse a design-system component rather than building a
second one that looks almost the same (RULES 19 and 20).
