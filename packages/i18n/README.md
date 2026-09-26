# packages/i18n (`@ufuq/i18n`)

## What this folder is for

Language and direction. Arabic is the primary language and the product is RTL-first
(DOCUMENT 27 RULE 24), but English is never second-class (RULE 25) — this package is what
keeps that true.

## What it contains

| Path               | Holds                                                               |
| ------------------ | ------------------------------------------------------------------- |
| `src/locales/ar/`  | The Arabic catalogue (`common.json`)                                |
| `src/locales/en/`  | The English catalogue (`common.json`)                               |
| `src/locale.ts`    | The supported locales, the default, and direction for each          |
| `src/messages.ts`  | The translator — key lookup and placeholder interpolation           |
| `src/format.ts`    | Dates and numbers in the right calendar and numerals                |
| `src/i18n.test.ts` | **Catalogue parity** — the two languages must hold the same key set |

## Which part of the system uses it

All three applications, and `apps/api` for its bilingual error messages.

## Important rules and dependencies

- **Both catalogues, always.** The parity test fails if a key is added to one language and
  not the other. This is deliberate: an untranslated string ships as a bug, not as English.
- **No user-facing string is written inline** in a component or a service.
- An error message is a user-facing string too — the API sends `message_ar` and
  `message_en` for every error code.

## Should developers add files here?

Add keys to both catalogues in the same change. Keep them grouped by feature so a screen's
strings stay together.
