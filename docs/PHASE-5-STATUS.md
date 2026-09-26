# Phase 5 — Employees: status

**Roadmap reference:** DOCUMENT 25, Phase 5
**Exit criterion:** _employees can be created, invited, and manage their own
login; the last-admin guard works._

**Status: COMPLETE.**

Every clause of the criterion is proved over HTTP against the real application
(`apps/api/test/employees.e2e.test.ts`) and was also exercised by hand in a
browser against the built API:

| Clause                         | Proof                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **created**                    | `POST /employees` writes the login user (status `invited`, no password) and the employee in one transaction; a failure injected _after_ the user insert leaves no user, no employee, no audit row and no email (DOCUMENT 26 §2 forced failure)                        |
| **invited**                    | The invitation email is captured at the mail transport; its link carries a single-use, 72-hour token in the URL fragment; a resend invalidates the previous link; deactivation kills an unaccepted one; reactivation issues a fresh one                               |
| **manage their own login**     | The invitee redeems the emailed token, signs in, reads their own employee record from `GET /auth/me`, and changes their own password — the old password then fails and the new one works                                                                              |
| **the last-admin guard works** | A company's only active ADMIN is refused (409 `LAST_ACTIVE_ADMIN`) when demoting or deactivating themselves; an admin who has not accepted their invitation does not count; once a second admin is active the demotion succeeds and ends the demoted admin's sessions |

---

## Verification results

The Phase 1–4 baseline was recorded before any change. It was **not green**:
`schema.prisma` held an unfinished Phase 5 start (the `EmployeeStatus` enum,
seven `employee.*` audit actions and a `Company.employees` relation to a model
that did not exist), so `@ufuq/db` failed to generate and neither the database
nor the API suites could run. Lint and the other six packages (165 tests)
passed. The partial work matched DOCUMENT 06/21 and was completed rather than
discarded.

After Phase 5:

| Command             | Result                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                                                                      |
| `pnpm lint`         | Pass — 0 errors (the 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`)                |
| `pnpm typecheck`    | Pass — 15/15 tasks                                                                                        |
| `pnpm test`         | Pass — 15/15 tasks, **474 tests**                                                                         |
| `pnpm build`        | Pass — 8/8 tasks; the employees and invitation routes build in `ar` and `en`                              |
| `pnpm verify`       | Not run — it boots the API against real PostgreSQL/Redis, and Docker is not available in this environment |

### Re-verification — 2026-09-23

The phase was re-checked from the committed tree in a later session, with the
Turborepo cache bypassed (`--force`) so every task genuinely re-ran rather than
replaying a cached log:

| Command                   | Result                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`       | Pass — "All matched files use Prettier code style"                                                          |
| `turbo run lint --force`  | Pass — 9/9 tasks, 0 errors (the same 4 pre-existing `no-console` warnings in `seed.ts`)                     |
| `pnpm typecheck`          | Pass — 15/15 tasks                                                                                          |
| `turbo run test --force`  | Pass — 15/15 tasks, **474 tests**, 0 cached                                                                 |
| `turbo run build --force` | Pass — 8/8 tasks; `admin/employees`, `admin/employees/new` and `accept-invitation` emitted in `ar` and `en` |

Per-package totals are unchanged from the table below (api 206, web 93, db 67,
auth 44, money 25, i18n 20, config 15, mobile 4). The `ERROR` lines the API
suite prints are the deliberate mail-relay failure injections, not failures.

Beyond re-running the commands, the claims this document makes were spot-checked
against the source rather than taken on trust:

- **Exit criterion** — `apps/api/test/employees.e2e.test.ts:688` redeems the
  emailed token over HTTP, signs in, reads the employee back from `GET /auth/me`,
  changes the password, and asserts the old password then fails; single-use,
  resend-invalidates-previous and already-active (409) are asserted alongside it.
- **Last-admin guard** — its own suite at line 1065.
- **Client `company_id` is never trusted** — it appears nowhere in
  `employees.controller.ts`; the company is taken from the session context
  (`ctx.companyId`), and a body carrying `company_id` is rejected as a field
  error (test at line 539).
- **Creation is one transaction** — the login user and the employee are both
  written inside `this.tenant(ctx, …)` in `employees.service.ts:165`.
- **Cycle prevention** — `rejectManagerCycle` walks the reporting chain bounded
  by the row count, so an already-cyclic chain cannot spin.
- **Migration** — `20260913000000_phase5_employees` carries the documented
  indexes, FK delete rules, the self-manager CHECK, `FORCE ROW LEVEL SECURITY`
  with the `tenant_isolation` policy, and the `employees_same_company` /
  `departments_same_company` triggers.

`pnpm verify` still requires Docker and was again not run.

### A4 completion — 2026-09-23

The DOCUMENT 04 A4 gap recorded below was closed in a follow-up pass. Only the
acceptance path changed; nothing else in Phase 5 was touched.

| Command                   | Result                                                               |
| ------------------------- | -------------------------------------------------------------------- |
| `pnpm format:check`       | Pass                                                                 |
| `turbo run lint --force`  | Pass — 9/9, 0 errors (the same 4 pre-existing `no-console` warnings) |
| `turbo run typecheck`     | Pass — 15/15                                                         |
| `turbo run test --force`  | Pass — 15/15, **481 tests** (474 + 7), 0 cached                      |
| `turbo run build --force` | Pass — 8/8; `accept-invitation` still prerenders in `ar` and `en`    |

`apps/api` 206 → **210**, `apps/web` 93 → **96**. Every other package is
unchanged.

**What A4 asked for, and where each part now is.**

_Read-only company name and employee name._ `POST /auth/invitation-preview`
resolves a token to exactly two strings — the company name and the employee's
full name — and **does not redeem it**: the invitee still has to post the token
with a password afterwards, and reloading the page does not burn their link.
`InvitationService.preview` is the only read of a token that does not spend it.

The token travels in the request body, not a path segment as the earlier
recommendation sketched (`GET /auth/invitations/{token}`). A path segment is
written verbatim into access logs, proxy logs and browser history by everything
it passes through, and DOCUMENT 20 §6 exists to keep this token out of exactly
those places; `POST` with the token in the body is how `accept-invitation`
already carries it. The method is `POST` for that reason, not because the call
changes anything — it does not.

Two abuse controls, because an unredeemed invitation is a bearer credential and
this is a public endpoint:

- **Rate limited per IP** on the login budget (5 attempts / 15 minutes,
  `LOGIN_RATE_LIMIT_*` — no new constant invented). A miss is the same opaque
  `TOKEN_INVALID` a redemption gives, so a hit is the only outcome that differs
  — which is precisely why the attempts have to be bounded.
- **Minimal payload.** The response carries the company name and the employee
  name and nothing else — no email, role, id or account state. Asserted by
  pinning the exact key set, not just the values.

_Terms checkbox._ Required, and enforced on **both** sides: the form refuses to
submit without it, and `AcceptInvitationDto.accept_terms` is `@IsBoolean()
@Equals(true)`, so `false` and a missing field are both 422 naming
`accept_terms`. A gate the page draws but the API does not apply would be
decoration, and this endpoint is public. A refusal on the terms leaves the
account `invited`, the password unset and the token unspent, so the invitee
ticks the box and carries on.

This changes the `POST /auth/accept-invitation` contract, which Phase 3 owns:
the body now has a third required field. Every existing caller was updated —
the acceptance page and the seven redemption call sites in the e2e suite. No
other caller exists in the workspace.

**Nothing was added to the schema.** A `terms_accepted_at` column would be an
invented field: DOCUMENT 06 §3.37 does not define one and DOCUMENT 21 lists no
audit action for it. Acceptance gates activation and is not separately
recorded — flagged below, because it is the kind of thing a legal review asks
for and the place to add it is a DOCUMENT 06 amendment, not this phase.

**Tests.** Four in `apps/api/test/employees.e2e.test.ts` — the preview names
the company and employee, a second preview still does not redeem (the
invitation's `accepted_at` is asserted null and the exit-criterion suite below
still spends the same token), the payload holds those two keys and nothing
matching a password, token or address, an unknown token is the same opaque
400, and an activation is refused with `accept_terms` false _and_ absent with
the account left untouched. Three in `apps/web/src/lib/employees.test.ts`
covering the form gate, which moved into a pure `acceptanceIssues` so the new
requirement is unit-tested rather than only asserted to exist.

**States and bilingual UI.** The page loads (skeleton) while the preview
resolves; a token the API will not resolve shows A4's "ask your administrator
to resend" rather than letting the invitee type a password that cannot be
accepted; a preview that cannot be reached shows an error with a retry that
keeps the captured token. Six catalogue keys were added in both `ar` and `en`
(parity test passes). The new CSS uses only logical properties and existing
design tokens, and the identity values are `unicode-bidi: isolate` so an Arabic
name on an English page — or the reverse — cannot drag the punctuation around
it.

### Test totals

| Package           | Tests   | Phase 5 additions                                                                                            |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/auth`   | 44      | **+6** — assignable roles (DOCUMENT 02 §7)                                                                   |
| `packages/config` | 15      | **+8** — SMTP configuration                                                                                  |
| `packages/i18n`   | 20      | — (catalogue parity now covers the Phase 5 keys)                                                             |
| `packages/money`  | 25      | —                                                                                                            |
| `packages/db`     | 67      | **+22** — `test/phase5-rls.test.ts`                                                                          |
| `apps/api`        | 206     | **+86** — `test/employees.e2e.test.ts` (69), `employee-query.test.ts` (11), `invitation-message.test.ts` (6) |
| `apps/web`        | 93      | **+22** — `lib/employees.test.ts`                                                                            |
| `apps/mobile`     | 4       | —                                                                                                            |
| **Total**         | **474** | **+144** (330 at the end of Phase 4)                                                                         |

### Browser verification

Docker is unavailable here, so the built API was run against an in-memory
PostgreSQL (PGlite, every migration applied, row-level security enforced) with
a demo company, and the Next dev server against it. Checked by hand:

- `/ar/admin/employees` and `/en/admin/employees` — RTL and LTR, desktop
  (table), tablet 768px and mobile 375px (cards, filters in a sheet); no
  horizontal page scroll at any width.
- Profile in both languages; the Salary tab's empty state; the deactivate
  dialog refusing an empty reason, then deactivating with the success notice.
- The create form: a duplicate employee ID returns a field error with a
  summary, **every value the admin typed kept**; a corrected submit lands on
  the new profile with "Employee added — Invitation sent".
- `/ar/accept-invitation#token=…`: the token is removed from the address bar,
  a too-short password is refused with the minimum stated, a valid one
  activates the account, and that employee then signs in and `GET /auth/me`
  returns their employee record.

This found one defect, fixed before completion: under React StrictMode the
acceptance page's mount effect ran twice, the second run saw the already
stripped fragment and replaced the token with "link incomplete". The token is
now kept once captured.

---

## Approved decisions this phase implements

Raised as `[DECISION REQUIRED]` before implementation and answered:

| Decision                                                                            | Where it lands                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Salary and leave allowances are deferred** to Phases 11 and 10                    | `POST /employees` has no `monthly_salary` / `leave_allowances`; no `employee_salaries` or `leave_balances` table; no Compensation/Leave form section; `GET/POST /employees/{id}/salary` not built |
| **Invitations are delivered over SMTP**, for transactional authentication mail only | `apps/api/src/mail/` (`MailTransport` → `SmtpMailTransport`, nodemailer); `SMTP_*`/`MAIL_FROM` in `@ufuq/config`; Mailpit in `docker-compose.yml`; e2e tests capture at the same transport        |
| **Email is required**; every employee gets a login user at creation (FLOW 02)       | `CreateEmployeeDto.email` required; `employees.user_id` stays nullable in the schema, as DOCUMENT 06 §3.6 specifies                                                                               |
| **Joining date: a valid calendar date only**, no future limit                       | `IsCalendarDate`; DOCUMENT 04 B3's "configurable tolerance" has no configuration home in any document — see open items                                                                            |
| **Folder layout** (raised when `packages/` and `apps/*` were renamed mid-session)   | `packages/`, `apps/api`, `apps/mobile`, `apps/web` restored. The root folder was later consolidated to `ufuq-main` (see `PROJECT-STRUCTURE.md`)                                                   |
| `departments.manager_employee_id` → Phase 5 (approved in Phase 4)                   | Column + enforced FK + same-company trigger; `POST/PATCH /departments` accept it; the departments screen offers it                                                                                |

---

## What is complete

### `packages/db` — migration `20260913000000_phase5_employees`

`employees` exactly as DOCUMENT 06 §3.6, with the migration implications
DOCUMENT 27 RULE 31 asks for at the top of the file. Indexes: `(company_id,
status)`, `(company_id, department_id)`, `manager_id`, unique `(company_id,
employee_code)`, unique `(company_id, email)` (DOCUMENT 08 §4.3), unique
`user_id` (DOCUMENT 06 §4, one-to-one). `ON DELETE SET NULL` for `manager_id`
and `user_id`, `RESTRICT` for everything historical (DOCUMENT 06 §5). A CHECK
refuses an employee as their own manager. `FORCE ROW LEVEL SECURITY` with the
`tenant_isolation` policy.

**Same-company triggers.** PostgreSQL checks a foreign key _without_ applying
row-level security, so a key alone would accept another company's department,
position, schedule, manager or user id. `employees_same_company` and
`departments_same_company` refuse such a write — for the application role and
for the owner — so DOCUMENT 07 §9 invariant 7 does not rest on the service
alone. Proved in `test/phase5-rls.test.ts`.

The seven DOCUMENT 21 employee audit actions are added; `employee.salary_changed`
is not, because nothing in Phase 5 can raise it.

### `apps/api/src/employees` — the endpoints

The DOCUMENT 08 §4.3 rows Phase 5 owns, with the permissions that table names:

| Method | Endpoint                     | Permission          |
| ------ | ---------------------------- | ------------------- |
| GET    | `/employees`                 | employee.view       |
| POST   | `/employees`                 | employee.create     |
| GET    | `/employees/{id}`            | employee.view       |
| PATCH  | `/employees/{id}`            | employee.update     |
| POST   | `/employees/{id}/deactivate` | employee.deactivate |
| POST   | `/employees/{id}/activate`   | employee.deactivate |
| POST   | `/employees/{id}/invite`     | employee.create     |

**Authorization — all four DOCUMENT 09 §4 checks.** Session (401); tenant
(row-level security, so another company's id is **404**); permission
(`PermissionsGuard`, 403); ownership scope resolved _into the query_ before
fetching (DOCUMENT 02 §5.3): `company` → no constraint, `team` → `manager_id =
caller`, `self` → `id = caller`. A caller's filters are AND-ed with the scope,
so a MANAGER cannot widen it by passing someone else's `manager_id`. An
in-tenant row outside scope is **403**. `callerEmployeeId` is now resolved by
`SessionAuthGuard`, which makes the `self`/`team` scopes Phase 3 prepared real.
Setting `manager_id` additionally requires `employee.assign_manager`.

**Validation (DOCUMENT 08 §5).** Whitelist (`company_id` in a body is 422);
every referenced id checked in the caller's company before any rule, all
failures reported together, another company's id indistinguishable from a
missing one; enums; trimming; Arabic-Indic digits normalised (phone, search);
control characters refused; lengths match the columns; email lowercased to
match `POST /auth/login`; a joining date that does not exist is 422, not 500;
`super_admin` is never assignable (DOCUMENT 02 §7); on PATCH an explicit `null`
for a NOT NULL field is 422. List: DOCUMENT 08 §4.3 filters, search on name,
code and email (word by word), sort whitelist `name | joining_date |
department` with a stable tiebreak, `per_page ≤ 100`.

**Business rules.** Manager cycles refused by walking the chain (DOCUMENT 06
§3.6). Last-admin guard with the active admin rows locked, so two admins
demoting each other concurrently cannot both succeed. Deactivation revokes all
sessions and any outstanding invitation in the same transaction; reactivation
restores the account, or re-invites if no password was ever set (DOCUMENT 09
§6). A role change revokes sessions (DOCUMENT 09 §3). The login email follows
the employee email. Deleting a department with active employees is 409
`DEPARTMENT_HAS_EMPLOYEES` (DOCUMENT 06 §3.4).

**Invitation email.** Issued in the transaction of the change that caused it,
delivered _after_ commit — a database transaction is never held open across
an SMTP conversation. A refused delivery never undoes the change: creation and
activation report it as `meta.invitation_delivery: "failed"`, and a resend
answers 503 `MAIL_DELIVERY_FAILED`. The token is stored only as a hash, sent
only in the URL fragment (DOCUMENT 20 §6), and never logged, audited or
returned. Bilingual, HTML-escaped, expiry in the company time zone.

**Audit (DOCUMENT 21).** `employee.created`, `employee.updated` (only changed
fields), `employee.department_changed`, `employee.manager_changed`,
`employee.role_changed` (old and new role, DOCUMENT 02 §7),
`employee.deactivated` (with the required reason — this is where it is kept),
`employee.activated`, `invitation.sent` (only once the relay accepted the
message), `session.revoked`. A PATCH that changes nothing writes nothing. No
record contains a token, password or password hash — asserted.

### `apps/web` — the admin screens

| Route                                 | Screen                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| `/{locale}/admin/employees`           | DOCUMENT 04 B2 — list, filters, search, sort, pagination |
| `/{locale}/admin/employees/new`       | DOCUMENT 04 B3 — create                                  |
| `/{locale}/admin/employees/:id`       | DOCUMENT 04 B4 — profile, Overview tab                   |
| `/{locale}/admin/employees/:id/{tab}` | The other six tabs (DOCUMENT 03 §3 sub-routes)           |
| `/{locale}/admin/employees/:id/edit`  | DOCUMENT 04 B3 — edit                                    |
| `/{locale}/accept-invitation`         | DOCUMENT 04 A4 — the page the invitation email opens     |

All four states on every screen: skeletons while loading; truly-empty ("No
employees yet" + Add employee) distinct from filtered-empty ("No results match
your filters" + Clear filters); error with retry that keeps the filters
visible and populated; success in a live region. Filters, search, sort and page
live in the URL; search debounces at 300 ms. Below 1024px the table becomes
cards with the fields that matter for scanning; below 640px the filters move
into a sheet with an apply action, form sections become an accordion with a
sticky save bar, and the profile tabs scroll horizontally. Input is preserved
on every failure; an unsaved-changes warning guards the form. Tab visibility
follows permissions (Salary needs `employee.view_salary`) and a hidden tab is
refused on the page too. Logical CSS properties and design tokens only; every
string from the catalogue in both languages; codes, emails, phones and dates
isolated `dir="ltr"`.

The five later-phase tabs (Attendance, Tasks, Goals, Requests, Monthly
reports) and Salary show an honest empty state — DOCUMENT 25 Phase 5 permits
empty tabs — and no sample data.

---

## Shared code Phase 5 touched, and why

Phase 1–4 behaviour is unchanged; every change below is additive or required by
the new table.

| Change                                                                             | Why                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.prisma` — completed the unfinished Phase 5 start                           | It broke `prisma generate` for the whole workspace                                                                                              |
| `SessionAuthGuard` — resolves `callerEmployeeId`                                   | DOCUMENT 09 §4 `self`/`team` scopes; Phase 3 left it `null` "until Phase 5"                                                                     |
| `GET /auth/me` — returns `employee`                                                | DOCUMENT 08 §4.1 lists it; Phase 3 returned `null` "until Phase 5"                                                                              |
| `InvitationService` — adds `issue` and `expirePending`; exported from `AuthModule` | One owner for the token lifecycle (DOCUMENT 27 RULE 6); Phase 3 built acceptance only                                                           |
| `SessionService.revokeAllForUserIn(tx, …)`                                         | Deactivation and role change must revoke sessions atomically; the existing method now delegates to it                                           |
| `@ufuq/config` — `mail` block; `SMTP_PASSWORD` is a secret key                     | Approved SMTP decision. `verify-foundation.mjs`, the health unit test and both earlier e2e suites gained the fields `Env` now requires          |
| `@ufuq/auth` — `ASSIGNABLE_ROLE_KEYS`                                              | DOCUMENT 02 §7; shared by the API DTO and pinned by a web test                                                                                  |
| Departments — `manager_employee_id` in DTO, payload, service, screen; delete guard | Approved Phase 4 decision; DOCUMENT 06 §3.4's own deletion rule                                                                                 |
| `errors.ts`, `describeError`, both catalogues                                      | The eight Phase 5 error codes, each saying what blocked the action and what to do next                                                          |
| `api-client.ts` — `fetchEnvelope`; `fetchOne` delegates to it                      | A create must read `meta.invitation_delivery`                                                                                                   |
| `apps/api/test/migrations.ts`; `auth.e2e` and `company-structure.e2e` use it       | The application under test reads `employees` on every request; a suite loading only its own phase's migration tested a schema no deployment has |
| `globals.css` — Phase 5 section appended                                           | Page, filter, profile, tabs, form and auth-card styles; nothing earlier changed                                                                 |
| `apps/web` devDependency on `@ufuq/auth`                                           | Test-only: pins the web copies of the assignable roles and minimum password length to the source                                                |
| `apps/api` dependency `nodemailer@10.0.9` (+ `@types/nodemailer`)                  | Approved SMTP decision                                                                                                                          |

---

## Assumptions stated rather than hidden

1. **`employees.phone` is `VARCHAR(32)`.** DOCUMENT 06 names the type without a
   length; 32 holds any E.164 number with the spaces and dashes people type.
2. **`status` is not writable on create or PATCH.** DOCUMENT 08 §4.3's body has
   no `status`, and `/deactivate`–`/activate` is the only lifecycle it defines.
   DOCUMENT 04 B3 lists "status" in the Employment section; the form does not
   offer it. Nothing in Phase 5 reaches `terminated`.
3. **The deactivation reason is kept in the audit record.** DOCUMENT 08 requires
   it; DOCUMENT 06 gives it no column, and DOCUMENT 21 is where "why did this
   change" belongs.
4. **Reference and uniqueness checks report every failing field at once**, and
   a unique violation that races past them is still turned into the field error.
5. **An inactive department, or an inactive employee, may still be chosen** as
   a department or manager. No document forbids it, and forbidding it would be
   an invented rule.
6. **Search uses DOCUMENT 08 §4.3's columns** (name, code, email). DOCUMENT 04
   B2 also says phone; DOCUMENT 08 is the API authority, as in Phase 4.
7. **The invitation locale** is the user's own locale if set, else the company
   default.
8. **Payload naming.** New payloads, including `employee` in `/auth/me`, are
   snake_case (DOCUMENT 08 §1). The Phase 3 camelCase in `/auth/*` is untouched
   and still worth reconciling before the API is public (noted in Phase 4).

---

## Open items — for a decision, not built

### ~~DOCUMENT 04 A4 shows the company and employee name, and a terms checkbox~~ — answered, built

Answered **B: build it**, and done — see "A4 completion" above. The acceptance
page now carries every component A4 lists. One narrower question took its
place, two items down: the terms _document_ the checkbox accepts.

### [DECISION REQUIRED] Where is the joining-date tolerance configured?

DOCUMENT 04 B3 validates "joining date not in the future beyond a configurable
tolerance"; no document gives the tolerance a home. Built: DOCUMENT 08's "valid
date" (approved). **Recommended:** a company setting if companies need it,
added as a DOCUMENT 06 amendment first.

### [DECISION REQUIRED] The terms the A4 checkbox accepts do not exist

**What is unclear.** A4's checkbox is now built, required and enforced, but no
document in the package provides terms of use for it to point at. The label
reads "I have read and accept the terms of use." and links to nothing, because
linking to a page that does not exist would be worse than not linking.

**Why it matters.** As it stands the checkbox is a real gate on activation but
an empty promise legally: nobody can read what they are accepting, and no
record is kept of the acceptance beyond the fact that activation succeeded.

**Options.** A) Supply a terms document, publish it, and link the label to it.
B) Additionally record acceptance — a `terms_accepted_at` on `users` (or the
invitation) plus a DOCUMENT 21 action — so there is evidence of who accepted
what, and when.

**Recommended: A now, B if a legal review asks for evidence.** Both need a
DOCUMENT 06 / DOCUMENT 21 amendment first; neither was invented here.

### Gaps outside Phase 5, carried forward

- **No web sign-in screen (DOCUMENT 04 A1)** — the Phase 3 gap Phase 4 already
  raised. An invitee can activate their account in the browser and sign in
  through the API, but there is still no login page to sign in _from_. It
  should be raised against Phase 3; it is not built here (DOCUMENT 27 RULE 5).
- **Entity history panel on the employee profile (DOCUMENT 21 "UI")** — needed
  `GET /audit-logs/entity/{type}/{id}`, which was built 2026-09-27 (see
  docs/PHASE-6-STATUS.md). **The panel was built 2026-09-28** on the
  profile's Overview tab, for callers holding `audit.view`.
- **Password-reset email delivery** — the SMTP transport now exists; wiring the
  Phase 3 reset token to it is Phase 3/15 work and was not done here.
- **Real SMTP delivery** was not exercised against Mailpit, because Docker is
  unavailable in this environment; every test captures at the transport
  interface the SMTP implementation sits behind.

---

## What is deliberately not here

- **Salary, compensation, leave allowances** — Phases 11 and 10, by decision.
- **`GET /employees/{id}/attendance`, `/performance`, `/monthly-reports`** —
  Phases 6, 8, 12. (`/attendance` was built 2026-09-27; see
  docs/PHASE-6-STATUS.md.)
- **"Assign task" / "assign goal" quick actions** — Phases 7 and 8.
- **Photo upload** — needs the attachments endpoint (DOCUMENT 08 §4.14); the
  avatar shows initials and `photo_path` is read-only.
- **"Work mode" filter on the list** — an attendance field (Phase 6); the
  employees API defines no such filter.
- **Bulk export** — V2 per DOCUMENT 04 B2.
- **A "custom schedule" per employee** — DOCUMENT 04 B3 mentions "template or
  custom"; no document defines a per-employee schedule, so the form chooses a
  company schedule, and a different week is a new schedule in settings.
- **The product sidebar** — as in Phase 4, most of its eleven modules do not
  exist yet, and linking to them would be a "coming soon" panel.
