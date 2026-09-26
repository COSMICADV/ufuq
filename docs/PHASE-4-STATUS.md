# Phase 4 — Company structure: status

**Roadmap reference:** DOCUMENT 25, Phase 4
**Exit criterion:** _a company can be created and fully configured, including a
working schedule that is not hardcoded anywhere._

**Status: COMPLETE.**

Company _creation_ is Phase 16 by approved decision, so what this phase
delivers is the second half of that criterion: a company can be fully
configured through the API and the admin screens, and every working-hours
value a later phase will read comes from that configuration. There is no
`WORKING_DAYS` constant, no default week, and no seeded schedule anywhere in
this repository — `grep -ri "working_days\|WORKING_DAYS" apps packages` returns
only the DOCUMENT 27 RULE 12 comments explaining why.

Verified by `format`, `lint`, `typecheck`, `test` and `build` across the
workspace (results below), by 178 new automated tests, and by driving the four
admin screens in a browser in both languages at mobile, tablet and desktop
widths.

---

## Verification results

| Command          | Result                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm format`    | Pass — `format:check` reports "All matched files use Prettier code style"                         |
| `pnpm lint`      | Pass — 9/9 tasks, 0 errors (4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`) |
| `pnpm typecheck` | Pass — 15/15 tasks                                                                                |
| `pnpm test`      | Pass — 15/15 tasks, **330 tests** across 8 packages                                               |
| `pnpm build`     | Pass — 8/8 tasks; all four settings routes prerendered in `ar` and `en`                           |

### Test totals

| Package           | Tests   | Phase 4 additions                                         |
| ----------------- | ------- | --------------------------------------------------------- |
| `packages/auth`   | 38      | —                                                         |
| `packages/config` | 7       | —                                                         |
| `packages/i18n`   | 20      | — (catalogue parity now covers the new keys)              |
| `packages/money`  | 25      | —                                                         |
| `packages/db`     | 45      | **+21** — `test/phase4-rls.test.ts`                       |
| `apps/api`        | 120     | **+93** — `test/company-structure.e2e.test.ts`            |
| `apps/web`        | 71      | **+64** — api-client, paging, schedule-week, settings-nav |
| `apps/mobile`     | 4       | —                                                         |
| **Total**         | **330** | **+178** (152 before this phase)                          |

---

## Approved decisions this phase implements

| Decision                                                                       | Where it lands                                                                                                  |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Company registration → Phase 16                                                | No registration endpoint or screen exists. `companies.created_by` stays nullable, as Phase 3 left it            |
| Company fields: name, logo, timezone, currency, locale, fiscal-month start day | `EDITABLE_FIELDS` in `company.service.ts` — `slug` and `status` are returned read-only and rejected on write    |
| Department status: `active` / `inactive`                                       | `department_status` enum, two values, in schema and migration                                                   |
| `departments.manager_employee_id` → Phase 5                                    | Column absent. It is a foreign key to `employees`; an unenforced UUID now is the shortcut that never gets fixed |

---

## What is complete

### `packages/db` — schema, migration, RLS

`20260908000000_phase4_company_structure` adds `departments`, `positions`,
`work_schedules`, `work_schedule_days` and `holidays` exactly as DOCUMENT 06
§§3.4–3.9 specify, with the migration implications DOCUMENT 27 RULE 31 asks for
written at the top of the file.

Every new tenant-scoped table `FORCE`s row-level security with a
`tenant_isolation` policy. `work_schedule_days` carries no `company_id` —
DOCUMENT 06 §3.8 defines none — so its policy walks the foreign key to its
schedule, which is itself row-level secured; a duplicated tenant column could
drift out of step with its parent's, and a policy that walks the key cannot.

Integrity that the service layer must not be the only guard for is in the
database: a working day always has both times and ends after it starts, a
non-working day has neither, `day_of_week` is 0–6, a department cannot be its
own parent, grace/break/half-day values fit inside the day they describe, and a
partial unique index allows at most one default schedule per company.

`half_day_threshold_hours` is `DECIMAL(4,2)`, not an integer. DOCUMENT 06 §3.8
names the column without fixing a type, and a 4.5-hour threshold is an ordinary
setting; rounding a company's configuration to whole hours would be exactly the
code-level constraint on configuration DOCUMENT 27 RULE 12 forbids. It crosses
the API as a string decimal and is parsed by `@ufuq/money`'s `Decimal` — the
workspace's one decimal implementation — so no such value passes through a
JavaScript `number`.

### `apps/api/src/company-structure` — the endpoints

Exactly the DOCUMENT 08 §4.2 rows, with the permissions that table names:

| Method | Endpoint               | Permission               |
| ------ | ---------------------- | ------------------------ |
| GET    | `/company`             | `settings.view`          |
| PATCH  | `/company`             | `settings.update`        |
| GET    | `/departments`         | `settings.view`          |
| POST   | `/departments`         | `settings.update`        |
| PATCH  | `/departments/{id}`    | `settings.update`        |
| DELETE | `/departments/{id}`    | `settings.update`        |
| GET    | `/positions`           | `settings.view`          |
| POST   | `/positions`           | `settings.update`        |
| GET    | `/work-schedules`      | `settings.view`          |
| POST   | `/work-schedules`      | `settings.work_schedule` |
| PATCH  | `/work-schedules/{id}` | `settings.work_schedule` |
| GET    | `/holidays`            | `settings.view`          |
| POST   | `/holidays`            | `settings.update`        |

**Tenancy.** No handler accepts a company identifier from the path, query or
body. `ctx.companyId` comes from the session (DOCUMENT 08 §1's critical rule),
`withTenant` binds it to the transaction, and row-level security enforces it
even if a service someday forgets a `where` clause. A `company_id` in a request
body is a 422, not a silently ignored key.

**Validation** (DOCUMENT 08 §5, all six points): whitelist rejection of unknown
fields; every referenced id checked against the caller's company before any
business rule runs; enums enforced against the documented sets; strings trimmed;
Arabic-Indic digits normalised to Latin; maximum lengths matching the columns.
Control characters — including the invisible bidirectional overrides, which
matter in a bidirectional product — are rejected rather than silently stripped.
Timezones are checked against the platform's own tz database rather than a list
this repository would have to maintain. A holiday date must be a date that
exists: `2026-02-30` is a 422, not a 500.

**Errors** follow DOCUMENT 08 §§2–3. Cross-tenant path ids return 404, not 403.
A referenced id in a _body_ returns 422 with `fields: { …: ["not_found"] }` —
which also confirms nothing, since a fictional id and another tenant's id are
indistinguishable in the response. 409 now maps to a real code (it previously
fell through to `INTERNAL_ERROR`), and so does 400.

**Audit** (DOCUMENT 21) is written inside the same transaction as the change it
documents, with `old_values`/`new_values` restricted to the fields that actually
changed. See "Audit coverage" below for what is and is not audited, and why.

### `apps/web` — the admin screens

`/admin/settings/company`, `/departments`, `/positions`, `/schedules` — the four
sections DOCUMENT 03 §3 gives Phase 4. Holidays live on the schedules screen
because DOCUMENT 04 B25 puts them there.

All four states on every screen (DOCUMENT 11 §2, DOCUMENT 27 RULE 27), modelled
as a discriminated union so a screen that fails to handle one does not compile:

- **Loading** — skeletons matching the layout, never a full-page spinner.
- **Empty** — explanation plus the action that resolves it.
- **Error** — what failed, in the reader's language, with a retry. An expired
  session gets its own message and no retry button, because retrying cannot help.
- **Success** — a live region so a confirmation carried only by colour and
  position is still announced.

The company screen has no empty state, and that is correct rather than an
omission: an authenticated session always belongs to a company, so "no company"
is unreachable; a record that cannot be read is the error state, and creating
one is Phase 16.

**RTL and LTR** (DOCUMENT 10 §9, DOCUMENT 27 RULES 24–25). Logical properties
throughout — there is no `left`, `right`, `margin-left` or `text-align: left` in
any Phase 4 style. `dir` and `lang` are set once on `<html>`. Timezones,
currency codes, times, dates and counters are wrapped `dir="ltr"` with
`unicode-bidi: isolate`. No string is written in code; the list separator is
translated too (`،` in Arabic, `,` in English). Verified in the browser: the
section nav sits on the **right** in Arabic and the **left** in English.

**Responsive** (DOCUMENT 22). Verified at 375×812, 768×1024 and 1440×900 in both
directions: no horizontal page scroll, every interactive target ≥ 44px on touch
devices, tables become stacked cards below 1024px with each cell carrying its
own label, and the section nav becomes a horizontal strip.

**Pagination** lives in the URL (DOCUMENT 11 §6, DOCUMENT 26 §9), with separate
keys for the two collections on the schedules screen so paging one never resets
the other.

**The week editor** starts blank — seven days, none of them working, no hours.
A form pre-filled with "Sunday to Thursday, nine to five" is a hardcoded working
week no matter how convenient it looks, and `schedule-week.test.ts` asserts that
`blankWeek()` has no working days precisely so a future convenience cannot
quietly reintroduce one.

---

## Audit coverage — and its documented boundary

DOCUMENT 21 enumerates the audited actions and states that "free-text actions
are not permitted". Under "Settings & data access" it lists
`settings.company_updated` and `settings.schedule_changed`. Both are implemented:

| Change                           | Action                      | Entity          |
| -------------------------------- | --------------------------- | --------------- |
| `PATCH /company`                 | `settings.company_updated`  | `company`       |
| `POST` / `PATCH /work-schedules` | `settings.schedule_changed` | `work_schedule` |
| `POST /holidays`                 | `settings.schedule_changed` | `holiday`       |

Holidays are audited under `settings.schedule_changed` because DOCUMENT 04 B25
places holidays inside schedule configuration and DOCUMENT 12's "holiday added
retroactively" edge case requires the change to be audited.

**Departments and positions are not audited**, because DOCUMENT 21 enumerates no
action for them and inventing `settings.department_created` would be both a
free-text action (forbidden by DOCUMENT 21) and an invented feature (DOCUMENT 27
RULE 2). This is a deliberate consequence of the specification as written, not
an oversight — flagged here so a reviewer can decide whether DOCUMENT 21's
catalogue should be extended.

A `PATCH` that changes nothing writes no audit record: DOCUMENT 21 stores only
the fields that changed, and with none changed there is nothing to store.

The rest of DOCUMENT 12's retroactive-holiday rule — "the admin is shown which
records would change and confirms explicitly" — concerns `attendance_records`,
which Phase 6 creates. In Phase 4 a new holiday has nothing to rewrite, so there
is nothing to confirm; that step belongs to the phase that gives it something to
say.

---

## Decisions required

### [DECISION REQUIRED] Positions and holidays: `GET`/`POST` only, or full CRUD?

**What is unclear.** DOCUMENT 08 §4.2 lists `GET/POST /positions` and
`GET/POST /holidays` with no `/{id}` row, while DOCUMENT 04 B25 describes the
positions settings screen as a "CRUD list". The two documents disagree.

**Why it matters.** As specified in DOCUMENT 08, an admin who mistypes a job
title or adds the wrong holiday date cannot correct it through the product. The
gap is small but permanent until it is closed.

**What was built.** DOCUMENT 08 §4.2 exactly — list and create for both, and no
row actions on the screens, because a button that produced a 404 would be worse
than its absence. DOCUMENT 08 is the API architecture document and is the
authority on the API surface; resolving the disagreement by writing endpoints it
does not define would be DOCUMENT 27 RULE 2.

**Options.**

- **A.** Keep DOCUMENT 08 as written. Positions and holidays are add-only in V1.
- **B.** Amend DOCUMENT 08 §4.2 to add `PATCH`/`DELETE /positions/{id}` and
  `DELETE /holidays/{id}`, and amend DOCUMENT 06 §3.9 to give `holidays` a
  `deleted_at` column (it has none today, so a holiday would be hard-deleted).
- **C.** Amend DOCUMENT 04 B25 to describe positions as an add-only list,
  matching DOCUMENT 08.

**Recommended: B**, limited to `PATCH /positions/{id}` and
`DELETE /holidays/{id}`. Correcting a typo and removing a wrongly-entered
holiday are ordinary settings work, and both are additive changes that need no
migration beyond the `holidays.deleted_at` column.

**Consequence of A or C:** the only correction path for either resource is
direct database access, which is precisely the kind of support script
DOCUMENT 27 RULE 32 exists to prevent.

---

## Assumptions stated rather than hidden

1. **`fiscal_month_start_day` accepts 1–28.** DOCUMENT 06 §3.1 gives the column
   a SMALLINT type and a default of 1, but no range. 1–28 is the only range
   naming a day that exists in every month; 29–31 would need a documented rule
   for February that no document states. Widening the bound later is additive.
2. **Grace period, unpaid break and half-day threshold are bounded by one day.**
   DOCUMENT 06 gives no bounds. A value longer than the day it describes is not
   a configuration choice; it is corrupt data. Enforced in both the DTO and a
   database CHECK.
3. **A department cannot be soft-deleted while child departments or positions
   still reference it.** DOCUMENT 06 §3.4 states the rule for employees, who do
   not exist until Phase 5; these are the two dependencies that exist today, and
   the rule is the same rule.
4. **`(company_id, name_ar)` is unique with no soft-delete predicate**, exactly
   as DOCUMENT 06 §3.4 specifies. A soft-deleted department therefore keeps its
   Arabic name reserved. Asserted in the API suite so the behaviour is visible
   rather than surprising.
5. **A schedule may have no working days, and a company may have no default
   schedule.** Both are states an admin can reach deliberately; forbidding them
   — or silently promoting another schedule — would be a workflow no document
   describes.
6. **Phase 4 payloads use snake_case field names**, per DOCUMENT 08 §1 ("Naming:
   snake_case fields") and §2's own examples. Phase 3's `/auth` payloads use
   camelCase for `accessToken`/`refreshToken`; that predates this phase and is
   left untouched. Worth reconciling before the API is public.

---

## Shared code Phase 4 touched, and why

Phase 1–3 functionality is unchanged. Four shared files were extended, all
additively; nothing that worked before behaves differently.

| Change                                                                | Why it was needed                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/envelope.ts` — added `collection()` and `CollectionMeta`      | DOCUMENT 08 §2's collection envelope had no implementation; Phase 3 had no list endpoint to need one                                                                                                                           |
| `common/errors.ts` — added 400 and 409 status mappings and 4 codes    | 409 previously fell through to `INTERNAL_ERROR`, so a business conflict would have reached the client as a server fault                                                                                                        |
| `globals.css` — modal height bound + mobile sheet; 44px touch targets | Both are DOCUMENT 22 requirements the Phase 2 base did not yet meet. A form taller than the viewport was literally unreachable                                                                                                 |
| `packages/design-tokens/package.json` — `--passWithNoTests`           | The package has no test files, so `vitest run` exited 1 and **failed `pnpm test` for the whole workspace before Phase 4 began**. One flag, no behaviour change. The package arguably still owes Phase 2 a token-integrity test |

`apps/api` gained a dependency on `@ufuq/money` for `Decimal`, so
`half_day_threshold_hours` is parsed by the workspace's one decimal
implementation rather than a second one written here (DOCUMENT 27 RULE 6).

`NEXT_PUBLIC_API_ORIGIN` was added to `.env.example`: the web client and the API
are separate origins, which is the arrangement the API's CORS allow-list was
already built for.

---

## Known gap outside this phase

**The web application has no login screen.** Phase 3 built the authentication
API but no UI for it, so the admin settings screens cannot currently be reached
by a browser session without authenticating out of band. The screens handle this
correctly — a 401 renders "your session has ended, sign in again" rather than a
generic failure — but the sign-in screen itself (DOCUMENT 04 A1) is a Phase 3
deliverable that does not exist. It is not built here: it is outside Phase 4's
scope, and DOCUMENT 27 RULE 5 says a feature does not tidy up a neighbouring
module on its way past. **It should be raised against Phase 3.**

---

## What is deliberately not here

- **Company registration** — Phase 16, by approved decision.
- **`departments.manager_employee_id`** — Phase 5, by approved decision.
- **Leave types, salary policy, performance weights, roles, notifications, audit
  log** — the other six `/admin/settings/*` sections in DOCUMENT 03 §3, each
  belonging to a later phase. They are not listed as disabled links: a link to a
  screen that is not built is a "coming soon" panel by another name
  (DOCUMENT 27 RULE 26).
- **A seeded work schedule.** DOCUMENT 27 RULE 12 permits one as a seed example,
  but seeding a Saturday-to-Thursday week is the fastest way for a later phase to
  start depending on it. The admin configures the first schedule, which is also
  what proves nothing else supplies one.
- **`is_overnight` on work schedules** — OD-05 recommends it _for the schema_,
  but OD-05 is an unresolved decision scoped to Phase 6 and DOCUMENT 06 §3.7
  lists no such column. The `end_time > start_time` CHECK constraint is what a
  migration must deliberately relax when OD-05 is answered.
- **Filters, search and sorting on the settings collections** — DOCUMENT 08 §4.2
  documents none. Pagination is implemented because §1 and §2 make it a global
  convention.
