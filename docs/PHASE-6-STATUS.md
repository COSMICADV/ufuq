# Phase 6 — Attendance: status

**Roadmap reference:** DOCUMENT 25, Phase 6
**Exit criterion:** _a full month of attendance can be recorded and reviewed,
with every status reachable and every calculation matching the schedule
configuration._

**Status: COMPLETE.**

DOCUMENT 25 calls this "the highest-value phase — everything downstream depends
on it being right", so each clause of the criterion is proved over HTTP against
the real application (`apps/api/test/attendance.e2e.test.ts`), not asserted
here:

| Clause                                           | Proof                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **a full month recorded**                        | March 2026 is walked day by day with real check-ins and check-outs, the nightly job filling the rest. The month ends with exactly 31 records for the employee, one per day, no duplicates                                                                                                                                                        |
| **and reviewed**                                 | The same month is read back through `GET /attendance/monthly` (31 columns), `GET /attendance?date=` (the daily board) and `GET /attendance/summary`                                                                                                                                                                                              |
| **every status reachable**                       | The month ends holding all eight DOCUMENT 12 statuses for one employee, asserted by name rather than by counting: `present`, `absent`, `late`, `on_leave`, `half_day`, `holiday`, `weekend`, `pending`                                                                                                                                           |
| **every calculation matching the configuration** | The derived minutes are asserted against the fixture schedule, and — the part that matters — **identical attendance under a second schedule produces different answers**: the same 09:20 arrival is 20 minutes late under one grace period and on time under another; the same day banks 120 minutes of overtime under `paid` and 0 under `none` |

The clock is controlled with `vi.setSystemTime`, faking `Date` only. That is
not a convenience: check-in accepts no timestamp from the client at all
(DOCUMENT 12 "Clock skew"), so moving the server's clock is the _only_ way to
record a month — which is itself a proof that the endpoint uses the server's
clock and nothing else.

---

## Verification results

| Command                   | Result                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`       | Pass — "All matched files use Prettier code style"                                                        |
| `turbo run lint --force`  | Pass — 0 errors (the 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`)                |
| `turbo run typecheck`     | Pass — 15/15 tasks                                                                                        |
| `turbo run test --force`  | Pass — 15/15 tasks, **642 tests**, 0 cached                                                               |
| `turbo run build --force` | Pass — 8/8 tasks; all six attendance routes prerender in `ar` and `en`                                    |
| `pnpm verify`             | Not run — it boots the API against real PostgreSQL/Redis, and Docker is not available in this environment |

### Final fix — 2026-09-23

Three spec gaps were closed after the phase was first reported complete. All
checks re-run with the Turborepo cache bypassed:

| Command             | Result                                                          |
| ------------------- | --------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                            |
| `lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings) |
| `typecheck --force` | Pass — 15/15                                                    |
| `test --force`      | Pass — 15/15, **642 tests** (+24), 0 cached                     |
| `build --force`     | Pass — 8/8                                                      |

1. **The correction window is a company setting**, not a constant — see the
   resolved item below. `apps/api` gains an end-to-end proof that a day the
   default refuses becomes reachable once the window is widened, that narrowing
   it closes days that were reachable a moment ago, and that one company's
   window does not move another's.
2. **System-generated rows name a designated system actor** — see the resolved
   item below. Proved: the actor is not the administrator, there is exactly one
   per company however many times generation runs, it cannot sign in, the
   database refuses to give it a password, and a password reset cannot reach it.
3. **The lateness rule is approved** rather than assumed. No code changed — the
   engine already measured from `scheduled_start` with grace gating the status
   only — so this is a documentation change, recorded under "Approved
   decisions" below.

Migration `20260924000000_phase6_correction_window_and_system_actor` carries all
of the schema work, written as a **separate** migration rather than an edit to
the Phase 6 one: a migration that has been written down is append-only, and
editing one a database may already have applied is how two environments quietly
stop sharing a schema.

One pre-existing suite needed a fix the change surfaced:
`packages/db/test/tenant-client.test.ts` applied only the Phase 3 migration
while driving the generated Prisma client, which always describes the whole
schema — so it broke on the first new column. It now reads the migrations
directory, as the API suites already did.

### Critical fix — 2026-09-26

An independent audit reported that `AttendanceGenerationService.runNightly()`
enumerated companies outside any tenant scope. **Confirmed, then fixed.**

**The defect.** `runNightly()` began with `this.prisma.company.findMany(...)`
and no `app.company_id` bound. `companies` is under FORCE row-level security
keyed on that setting, so `ufuq_app` — the only role the running application
uses — saw **zero companies**. The nightly job would have reported success
every hour and generated nothing, for every company. No earlier suite caught
it: the Phase 6 e2e suite drives `generateRange` for a company it already
knows, and nothing called `runNightly()` at all.

**Reproduced under the real application role** before any change was made:
the new `apps/api/test/attendance-nightly.e2e.test.ts` boots the real
application, switches the connection to `ufuq_app` (asserted in the test:
`current_user = ufuq_app`, `rolbypassrls = false`, `rolsuper = false`), seeds
two active companies and one suspended one through `withTenant`, and calls
`runNightly()`. Against the unfixed code it returned an empty map. Four of
the seven tests failed. The three that passed were the isolation assertions,
which pass trivially when nothing is written.

**The fix** — migration `20260926000000_phase6_nightly_company_enumeration`:

- `platform_list_active_company_ids()`: a `SECURITY DEFINER` function that
  returns the ids of active, non-deleted companies and **nothing but the id**.
  `EXECUTE` is revoked from `PUBLIC` and granted to `ufuq_app` only. This is
  the same explicit, greppable bypass point DOCUMENT 09 §7 already sanctions
  for the `auth_lookup_*` functions. Row-level security is not disabled or
  loosened on any table, and no role gained BYPASSRLS.
- `@ufuq/db` exports one typed wrapper, `listActiveCompanyIds`
  (`packages/db/src/platform-lookups.ts`), called inside
  `withPlatformContext`. That keeps the raw function name in one place, as
  `auth-lookups.ts` does for the auth functions.
- `runNightly()` takes the ids from that call. Everything else is read and
  written inside each company's own `withTenant` scope: the company's
  timezone (read there rather than returned by the function, so the function
  discloses nothing else), its employees, its system actor, its rows and its
  audit records.

Like the `auth_lookup_*` functions, the new function runs as its owner, the
migration role. It depends on that role being the deploy-time superuser
described in the Phase 3 migration. That is not a new assumption: login
already depends on it.

**Proved** (`attendance-nightly.e2e.test.ts`, 7 tests, all under `ufuq_app`):
both active companies are processed and the suspended one is not; each
company's counts are its own employees (2 and 1, not 3); every row carries its
own company id and belongs to its own employees; each company's audit records
name its own system actor, and the two actors differ; neither company can see
the other's rows or audit records afterwards; and with no tenant bound the
role still sees no companies and no attendance, so the enumeration loosened
nothing. `packages/db/test/phase6-rls.test.ts` adds the function's own
guarantees: `ufuq_app` with no tenant sees no companies directly, the
function returns only `{ id }`, suspended and soft-deleted companies are left
out, and `PUBLIC` cannot execute it.

**The correction window has no maximum.** The 365-day upper bound added in
the final fix was not documented anywhere: DOCUMENT 12 rule 13 gives a
default of 7 and says the window is configurable per company. The same
migration replaces `companies_correction_window_days_range`
(`BETWEEN 1 AND 365`) with `companies_correction_window_days_min`
(`>= 1`). That is strictly looser, so no existing row can fail it. The DTO
drops `@Max(365)`. The only ceiling left is `CORRECTION_WINDOW_DAYS_STORAGE_MAX`
= 32 767, the largest value the SMALLINT column can store. Without it, a
larger value would fail inside PostgreSQL and surface as a 500 instead of a 422. It is a storage limit, not a policy. Both catalogues' helper text now
says "at least 1" instead of "1–365". Default 7, minimum 1, per company, all
unchanged.

| Command             | Result                                                          |
| ------------------- | --------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                            |
| `lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings) |
| `typecheck --force` | Pass — 15/15                                                    |
| `test --force`      | Pass — 15/15, **654 tests** (+12), 0 cached                     |
| `build --force`     | Pass — 8/8                                                      |

Affected suites were run first (`phase6-rls`, `attendance.e2e`,
`company-structure.e2e`, `attendance-nightly.e2e`), then the full set above.
Two existing assertions changed, both because they encoded the removed
365 cap: `phase6-rls.test.ts` now accepts 366 instead of refusing it, and
`company-structure.e2e.test.ts` refuses 0, -1 and 32 768, and separately
accepts 366.

### Pre-Phase 7 cleanup — 2026-09-27

Three items, each scoped by the request that raised it. Phase 7 was not
started.

**1. `platform_list_active_company_ids()` — `search_path` was not safe; fixed.**
EXECUTE was already correct (revoked from `PUBLIC`, granted to `ufuq_app`
only) and is unchanged. The `search_path` was not. The function was declared
`SET search_path = public`, and PostgreSQL searches the session's temporary
schema _before_ every schema in the path unless `pg_temp` is named
explicitly. `ufuq_app` holds TEMP on the database. Reproduced before the
change: as `ufuq_app`, `CREATE TEMP TABLE companies (…)` followed by a call
to the function returned the temp table's row instead of the real companies.
Migration `20260927000000_platform_lookup_search_path` redefines it with
`SET search_path = pg_catalog, public, pg_temp` (the PostgreSQL manual's form
for SECURITY DEFINER functions) and a schema-qualified body
(`public.companies`, `public.company_status`). The signature, result and
grants are unchanged. `phase6-rls.test.ts` now asserts the pinned setting and
that a temp `companies` table no longer changes the result.

The Phase 3 `auth_lookup_*` functions use the same `SET search_path = public`
form. They were outside this item's scope and were **not** changed; see the
open item below.

**2. `GET /employees/{id}/attendance?month=YYYY-MM` (DOCUMENT 08 §4.3) — built.**
Handled by `EmployeeAttendanceController` in the attendance module (the
employees module still does not depend on attendance). No business logic was
duplicated. The month's per-day cells and status totals come from
`monthlyRow`, extracted from `GET /attendance/monthly` so the two endpoints
cannot total a month differently. Records use `listWhere` and
`attendancePayload`. The employee is scoped with the existing
`employeeScopeWhere(ctx, 'attendance.view')`. Checks run in DOCUMENT 09 §4
order: another company's employee is **404**, an in-tenant employee outside
the caller's `attendance.view` scope (`self` / `team` / `company`) is
**403**, and an in-scope employee with nothing recorded gets an empty month
rather than an error. Six e2e tests in `attendance.e2e.test.ts`, including one
asserting that the endpoint's days and totals equal the matrix row for the same
employee.

**3. The DOCUMENT 21 audit read surface — built.**

| Method | Endpoint                         | Permission |
| ------ | -------------------------------- | ---------- |
| GET    | `/audit-logs`                    | audit.view |
| GET    | `/audit-logs/entity/{type}/{id}` | audit.view |

- **`audit.view` only.** The permissions guard enforces it on both routes, and
  DOCUMENT 02 gives it to ADMIN alone, so there is no self/team narrowing to
  apply.
- **Tenant-scoped.** Every query runs in `withTenant`, and no query names a
  company id. Another company's record history is an empty list, not a
  confirmation that the record exists. `company_id` in the query string is 422.
- **Read-only.** `AuditModule` has no write path and does not import
  `AuditService`. POST, PUT, PATCH and DELETE on the resource are 404
  (asserted), and the database already denies UPDATE and DELETE to `ufuq_app`.
- **Filters as documented:** user, entity type, entity id, action (spelled as
  DOCUMENT 21 spells it, e.g. `attendance.checked_in`, read from the Prisma
  client's own enum mapping rather than a second list), and a `from`/`to`
  date range read in the company's timezone. `to` before `from` is 422.
  Pagination is DOCUMENT 08 §1's `page`/`per_page` (max 100) with the §2
  envelope. Order is fixed at newest first, because DOCUMENT 08 documents no
  sort whitelist for this endpoint.
- **Old and new values** are returned as stored, with the actor (employee name,
  else email, and a flag for the system actor), IP and user agent.
- **Salary values** are replaced by `[redacted]` for a caller without
  company-wide `employee.view_salary` (DOCUMENT 21 "Captured with care"). No
  salary is audited yet; the rule is in place for when one is.

`/{locale}/admin/settings/audit-log` is a new settings section:

- Each entry is a sentence ("سجّل أحمد محمد الحضور" / "Ahmed Mohamed checked
  in"). The templates put `{actor}` where each language wants it, so Arabic
  reads verb-first.
- Each entry has a `<details>` disclosure with the field-by-field old/new
  table, the action code, the full record id, IP and user agent. Values stay
  `dir="ltr"` inside Arabic text.
- Every documented filter is held in the URL. User and record filters are set
  from an entry ("only this person's actions", "this record's history")
  rather than from a new user picker.
- All four states are handled: skeleton; two distinct empty states (nothing
  recorded, nothing matching); error with retry, plus a specific message for
  403 and for invalid filters; and the list.
- Checked in the browser pane in `ar` (RTL) and `en` (LTR), and at 375px
  with no horizontal scroll. The populated list could not be checked
  visually: no API or database runs in this environment, so the pane showed
  the error state.

**Not built, deliberately:** DOCUMENT 21's entity history panels on task,
payroll-line and product screens. Those screens belong to later phases, and
`GET /audit-logs/entity/{type}/{id}` is ready for them. The one panel whose
screen already exists, the employee profile (Phase 5), was not requested
here and is listed as an open item below.

| Command             | Result                                                              |
| ------------------- | ------------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                                |
| `lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings)     |
| `typecheck --force` | Pass — 15/15                                                        |
| `test --force`      | Pass — 15/15, **697 tests** (+43), 0 cached                         |
| `build --force`     | Pass — 8/8; `/admin/settings/audit-log` prerenders in `ar` and `en` |

The affected suites ran first: `phase6-rls`, `attendance.e2e`,
`audit-logs.e2e` (19), `audit-log-payload` (6), and web `audit` (10) and
`settings-nav` (+1). The full set above ran after them.

### Final pre-Phase 7 hardening — 2026-09-28

Three items, each scoped by the request that raised it. Phase 7 was not
started.

**1. The five `auth_lookup_*` SECURITY DEFINER functions — `search_path` pinned.**
This is the weakness recorded as an open item on 2026-09-27, now fixed.
Migration `20260928000000_auth_lookup_search_path` redefines
`auth_lookup_login`, `auth_lookup_session`,
`auth_lookup_session_by_refresh_hash`, `auth_lookup_reset_token` and
`auth_lookup_invitation_token`:

- `SET search_path = pg_catalog, public, pg_temp`, with every table and enum
  type schema-qualified (`public.users`, `public.user_status`, …).
- Each body is otherwise the current definition. `auth_lookup_login` keeps
  the Phase 6 `NOT u.is_system` exclusion, and no result column, filter or
  signature changed.
- Grants are restated: `PUBLIC` has no EXECUTE, and `ufuq_app` has EXECUTE
  and nothing more.
- Row-level security is untouched.

New suite `packages/db/test/auth-lookup-search-path.test.ts` (7 tests) proves
it both ways, so it cannot pass by accident:

- Against the migrations **before** the fix, temporary `users`, `companies`,
  `sessions`, `password_reset_tokens` and `invitations` tables change what
  **every one** of the five functions returns. The weakness was real.
- Against the migrations **with** the fix, the same temp tables change
  nothing, and each lookup still finds its real row.
- The system actor stays invisible to login.
- `proconfig` is pinned on all five, they remain SECURITY DEFINER, EXECUTE is
  `ufuq_app`-only, and with no tenant bound `ufuq_app` still sees no rows in
  any of the underlying tables.

Authentication flows run against the hardened functions:

| Flow                       | Suite                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| login (web and mobile)     | `auth.e2e` — including lockout and rate limiting                                                                          |
| session resolution         | every authenticated request in every e2e suite                                                                            |
| mobile refresh             | `auth.e2e` — rotation and reuse refusal                                                                                   |
| forgot password            | `auth.e2e` — **new**: 200 for known and unknown email alike, a token only for the real account                            |
| reset password             | `auth.e2e` — **new**: sets the new password once, the old one stops working, a reused or unknown token is `TOKEN_INVALID` |
| invitation lookup / accept | `employees.e2e` — the acceptance page and invitation → own login                                                          |

`POST /auth/reset-password` had no HTTP test before this. The raw token is
never returned to a client, because delivering it by email is Phase 15, so
the new test obtains it from the real `PasswordService.createResetToken` and
then drives the endpoint over HTTP.

**2. The DOCUMENT 21 employee history panel — built.** It sits on the employee
profile's Overview tab (`components/employees/employee-history.tsx`).

- It reads `GET /audit-logs/entity/employee/{id}` and nothing else, so it
  shows the employee record's own trail. User-account events such as logins
  have entity type `user` and are not included.
- It renders only when the caller holds `audit.view`, and the API refuses
  anyone else again. It is read-only.
- It uses the same `AuditEntryItem` as the audit log screen, moved to
  `components/settings/audit-entry.tsx` so an entry cannot read differently in
  the two places: a sentence plus the expandable old/new detail, in Arabic RTL
  and English LTR.
- States: loading skeleton, an empty state, an error state with retry and a
  specific message for 403, and the list. It pages through its own
  `history_page` URL key, and links to the full audit log pre-filtered to
  this employee.
- The seven profile tabs are unchanged.
- `employees.e2e` adds 3 tests for the endpoint: the employee's own trail
  only (including `employee.created`), 403 for a MANAGER and for the
  EMPLOYEE themselves, and nothing for another company. `lib/audit.test.ts`
  adds 2 tests for the link helpers.
- Not checked in the browser pane: the profile page needs `GET /employees/{id}`
  from an API that does not run in this environment.
- The task, payroll-line and product panels were not built. Those screens
  belong to later phases.

**3. Temporary preview config removed.** The `.claude/launch.json` created on
2026-09-26 in the folder **above** `ufuq-main`, only to start the browser
preview, has been deleted, along with its now-empty folder. The project's own
`ufuq-main/.claude/launch.json` (from Phase 4) is unchanged.

| Command             | Result                                                          |
| ------------------- | --------------------------------------------------------------- |
| `pnpm format:check` | Pass                                                            |
| `lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings) |
| `typecheck --force` | Pass — 15/15                                                    |
| `test --force`      | Pass — 15/15, **712 tests** (+15), 0 cached                     |
| `build --force`     | Pass — 8/8                                                      |

The affected suites ran first: `auth-lookup-search-path`, the rest of
`packages/db`, `auth.e2e`, `employees.e2e`, `audit-logs.e2e` and web
`audit`. The full set above ran after them.

### Test totals

| Package           | Tests   | Phase 6 additions                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/auth`   | 44      | —                                                                                                                                                                                                                                                                                                                              |
| `packages/config` | 15      | —                                                                                                                                                                                                                                                                                                                              |
| `packages/i18n`   | 20      | — (catalogue parity now covers the Phase 6 and audit keys)                                                                                                                                                                                                                                                                     |
| `packages/money`  | 25      | —                                                                                                                                                                                                                                                                                                                              |
| `packages/db`     | 109     | **+42** — `test/phase6-rls.test.ts` (19, then +11 for the final fix, +4 for the critical fix, +1 for the cleanup), `test/auth-lookup-search-path.test.ts` (7)                                                                                                                                                                  |
| `apps/api`        | 364     | **+154** — `test/attendance.e2e.test.ts` (80), `test/audit-logs.e2e.test.ts` (19), `test/attendance-nightly.e2e.test.ts` (7), `src/audit/audit-log-payload.test.ts` (6), `src/attendance/calculation.test.ts` (33), `test/company-structure.e2e.test.ts` (+3), `test/auth.e2e.test.ts` (+3), `test/employees.e2e.test.ts` (+3) |
| `apps/web`        | 131     | **+35** — `lib/attendance.test.ts` (22), `lib/audit.test.ts` (12), `lib/settings-nav.test.ts` (+1)                                                                                                                                                                                                                             |
| `apps/mobile`     | 4       | —                                                                                                                                                                                                                                                                                                                              |
| **Total**         | **712** | **+231** (481 at the end of Phase 5)                                                                                                                                                                                                                                                                                           |

Two defects were found by these tests and fixed before completion, both worth
recording because neither would have been visible by reading the code:

1. **`ufuq_app` could delete attendance.** DOCUMENT 12 says attendance is never
   hard-deleted, and the migration granted only `SELECT, INSERT, UPDATE` — but
   Phase 3 set `ALTER DEFAULT PRIVILEGES … GRANT … DELETE ON TABLES`, so every
   new table arrives with DELETE already granted and naming three privileges in
   a GRANT takes nothing away. An explicit `REVOKE DELETE` is what actually does
   it. The row-level-security suite asserts the revoke.
2. **A cross-tenant insert is refused by the same-company trigger, not by the
   policy's `WITH CHECK`.** The trigger fires first, and its own lookup is
   row-secured, so asked about another company's employee it cannot see that
   employee and says so. Both guards refuse the write; the test now says which
   one reaches it first rather than asserting a message that never appears.

---

## What is complete

### `packages/db` — migration `20260923000000_phase6_attendance`

`attendance_records` and `attendance_correction_requests` exactly as
DOCUMENT 06 §3.10–3.11, with the DOCUMENT 27 RULE 31 migration implications at
the top of the file. Four new types (`work_mode`, `attendance_status`,
`attendance_source`, `correction_status`) and the seven DOCUMENT 21 attendance
audit actions.

Indexes are DOCUMENT 06's: unique `(employee_id, date)` — which is what makes a
double check-in a clean 409 rather than two rows — plus `(company_id, date)`,
`(employee_id, date)` and `(company_id, status, date)`. `ON DELETE RESTRICT` to
employees and companies, because attendance is historical and feeds payroll.

**Constraints that keep a row coherent**, each because the alternative is a row
no later phase can interpret: a check-out must follow its check-in; derived
minutes are never negative; a check-in always carries a work mode (DOCUMENT 12
rule 2 — a check-in without one is the "WFH as an afterthought" the spec
rejects); a decided correction names its reviewer and a rejected one carries a
note (DOCUMENT 12 validation).

**Row-level security** with `FORCE` and the `tenant_isolation` policy on both
tables, and `attendance_records_same_company` / `attendance_corrections_same_company`
triggers, because PostgreSQL checks a foreign key without applying row security
(DOCUMENT 07 §9 invariant 7). Proved in `packages/db/test/phase6-rls.test.ts`.

### `apps/api/src/attendance` — the engine, the endpoints, the job

**The calculation engine (`calculation.ts`) is pure.** A day, a schedule and
what the employee did go in; the minutes and the status come out. It reads no
clock, no database and no environment, which is what lets the exit criterion's
third clause be stated directly as tests. It contains no working week, no
default day and no hours — start, end, grace, break, the half-day threshold and
the overtime policy all arrive as arguments from `work_schedules` /
`work_schedule_days` (DOCUMENT 27 RULE 12). `grep -n "09:00\|WORKING_DAYS" apps/api/src/attendance`
returns only test fixtures and the comments explaining why.

**Timezone arithmetic (`zoned-time.ts`) takes the zone as an argument**, so a
test can ask what 09:00 in Africa/Cairo was without the machine being in Cairo.
Which calendar day a check-in belongs to is decided in the schedule's zone —
never the browser's, never the server's locale (DOCUMENT 12 "Timezone").

The DOCUMENT 08 §4.4–4.5 rows, with the permissions that table names:

| Method | Endpoint                               | Permission                             |
| ------ | -------------------------------------- | -------------------------------------- |
| POST   | `/attendance/check-in`                 | attendance.check_in                    |
| POST   | `/attendance/check-out`                | attendance.check_out                   |
| GET    | `/attendance/today`                    | attendance.check_in                    |
| GET    | `/attendance`                          | attendance.view                        |
| GET    | `/attendance/monthly`                  | attendance.view                        |
| GET    | `/attendance/summary`                  | attendance.view                        |
| PATCH  | `/attendance/{id}`                     | attendance.update                      |
| POST   | `/attendance-corrections`              | attendance.request_correction          |
| GET    | `/attendance-corrections`              | approve_correction **or** as requester |
| GET    | `/attendance-corrections/{id}`         | scope-checked                          |
| POST   | `/attendance-corrections/{id}/approve` | attendance.approve_correction          |
| POST   | `/attendance-corrections/{id}/reject`  | attendance.approve_correction          |
| POST   | `/attendance-corrections/{id}/cancel`  | own, pending only                      |
| GET    | `/employees/{id}/attendance`           | attendance.view (added 2026-09-27)     |

The correction list and detail carry no `@RequirePermission`: DOCUMENT 08 §4.5
makes them reachable by an approver _or_ by the requester, which is not one
permission a guard could name. The service resolves whichever the caller holds
and refuses a caller with neither — the check is not skipped, it is made where
it can be made correctly (DOCUMENT 27 RULE 9).

**Authorization — all four DOCUMENT 09 §4 checks.** Session (401); tenant (row
security, so another company's id is **404**); permission (403); ownership scope
resolved _into the query_ before fetching (DOCUMENT 02 §5.3): `company` → no
constraint, `team` → the caller's reports, `self` → the caller. A caller's
filters are AND-ed with the scope, so an employee passing somebody else's
`employee_id` gets an empty list, never their attendance. An in-tenant record
outside scope is **403**.

**Business rules.** Work mode required with no default. A rest day or holiday is
a _confirmation_, not a refusal — the first attempt is 409 `NON_WORKING_DAY`,
and confirming records the day, with every worked minute counting as overtime
because nothing was scheduled. Check-out without check-in is 409
`NOT_CHECKED_IN`, which is what points at the correction flow (rule 14).
Corrections are limited to a past date inside the window, one open request per
day. Approval writes the attendance change **and** the audit record in one
transaction (DOCUMENT 04 B7), recalculating from the schedule in effect on that
date rather than copying the requested times — an approver approves _times_, and
what they mean is the schedule's business. Rejection requires a reason. An
employee may cancel only their own, only while pending.

**Generated days (`attendance-generation.service.ts`)**, all idempotent, all
`source = system`: weekends and holidays so a month is complete (rule 9);
absence for a finished working day with no record (rule 10); and a forgotten
record closed at the scheduled end and left `pending` — deliberately with
`working_minutes` null, because the employee never said when they left and a
guess would be indistinguishable from a fact. Nothing generated ever overwrites
a day somebody recorded; running the job twice writes nothing the second time.
Both are asserted. A day still in progress is not marked absent. Mid-month
joiners and leavers fall out of the per-day employment window, so those days are
absent from the month rather than counted against anybody.

**The nightly job (`attendance-jobs.ts`)** is BullMQ on the existing Redis —
the first background job the product has, which is what `RedisModule` has been
waiting for since Phase 3. It is a repeatable job under a fixed scheduler key
rather than a timer in the process: the API runs as more than one instance, and
a `setInterval` in each would run the job once per instance. It wakes hourly and
asks each company what "yesterday" is **in that company's own timezone** — a
single daily UTC run would fire before midnight for companies east of UTC and
hours late for those west of it. Which companies to visit comes from
`platform_list_active_company_ids()`, the one lookup made outside a tenant;
each company is then processed inside its own tenant scope (see the
2026-09-26 critical fix). `AttendanceModule.register({ scheduler: false })`
builds the module without the worker, which is how the e2e suites boot the
application without a worker attaching to the test's Redis.

**Audit (DOCUMENT 21).** All seven actions: `attendance.checked_in`,
`checked_out`, `adjusted_by_admin` (with old and new values **and** the required
reason), `correction_requested`, `correction_approved`, `correction_rejected`,
`generated_by_system`. Every record is written inside the transaction of the
change it describes, so a rolled-back change leaves none. No attendance audit
record contains a password, token or hash — asserted.

### `apps/web` — the six screens

| Route                                     | Screen                                            |
| ----------------------------------------- | ------------------------------------------------- |
| `/{locale}/admin/attendance`              | DOCUMENT 04 B5 — daily board                      |
| `/{locale}/admin/attendance/monthly`      | DOCUMENT 04 B6 — monthly matrix                   |
| `/{locale}/admin/attendance/corrections`  | DOCUMENT 04 B7 — corrections, side-by-side detail |
| `/{locale}/app/attendance`                | DOCUMENT 04 C2 — today, month chips, record list  |
| `/{locale}/app/attendance/history`        | DOCUMENT 04 C3 — month calendar                   |
| `/{locale}/app/attendance/correction/new` | DOCUMENT 04 C4 — correction request               |

All four states on every screen: skeletons while loading; two distinct empty
states on the board (nothing recorded vs nothing matching the filters, each
with its own next step); error with retry; success in a live region.

**The attendance card never renders an action whose result is unknown**
(DOCUMENT 04 C1, DOCUMENT 12 "load failure"). The buttons come from the
server's `can_check_in` / `can_check_out`; while the state is loading or has
failed there are _no_ buttons, not disabled-looking ones. Two large buttons
(`OFFICE` / `WFH`) at 56px minimum before check-in, because work mode has no
default; a full-width check-out after; a live duration on a one-minute timer.
A rest day raises the confirmation dialog DOCUMENT 12 specifies.

The matrix freezes the employee column with `inset-inline-start`, so it freezes
on the correct side in both directions. Below 1024px it is **replaced, not
shrunk** — DOCUMENT 04 B6 says so in as many words — by a one-employee-at-a-time
month; the wide tables become cards. Logical properties and design tokens only;
every string from the catalogue in both languages; times, dates and codes
isolated `dir="ltr"` so an Arabic page cannot reorder `7:05`.

Times are rendered in the **company's** timezone, decided in one place
(`attendance-shared.tsx`), never the browser's.

---

## Shared code Phase 6 touched, and why

Phase 1–5 behaviour is unchanged; every change below is additive.

| Change                                                                   | Why                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `schema.prisma` — four enums, two models, seven audit actions, relations | The tables this phase owns                                                                                            |
| `AppModule.register(env, info, options)` — a third, defaulted argument   | A test suite boots the application for its endpoints and must not also start a BullMQ worker against the test's Redis |
| `errors.ts`, both catalogues — eight Phase 6 error codes                 | DOCUMENT 12 "ERROR STATES": each says what blocked the action and what to do instead                                  |
| `apps/api` dependency `bullmq`                                           | The nightly job (AD-01). Redis was already connected                                                                  |
| `globals.css` — Phase 6 section appended                                 | Card, board, matrix, calendar, correction and responsive styles; nothing earlier changed                              |
| The three earlier e2e suites — `{ backgroundJobs: false }`               | Required by the new argument above. No assertion in any of them changed                                               |

`apps/web` reuses the Phase 4 weekday labels (`settings.day_0` … `day_6`)
rather than restating them, so the calendar's columns and the schedule's rows
cannot drift apart (DOCUMENT 27 RULE 20).

---

## Assumptions stated rather than hidden

These are places DOCUMENT 12 defines a rule but not its every detail. Each is a
decision that payroll will later divide by, so each is written down rather than
buried in the engine.

1. **The lateness rule is approved, not assumed.** DOCUMENT 12 rule 4 defines
   the _condition_ and not the quantity; the reading below was raised and has
   since been confirmed: `late` status when
   `check_in > scheduled_start + grace`; `late_minutes` = the minutes between
   `scheduled_start` and the actual check-in; and grace decides the **status
   only** — it is never subtracted from `late_minutes`. Arriving 20 minutes
   after a 09:00 start with 15 minutes of grace is `late` by 20, not by 5. This
   is what `lateMinutesFor` has always done, so the approval changed no code;
   it is recorded here so Phase 11 can divide by it without re-opening the
   question.
2. **`scheduled_minutes` is the configured span net of the unpaid break.**
   Rule 6 compares it with `working_minutes`, which rule 5 defines net of the
   break; measuring one gross and the other net would hand every employee the
   break as overtime.
3. **Under the `none` overtime policy the stored value is 0**, not the computed
   excess — the company does not recognise overtime, so recording a number
   nothing may use would invite a later phase to use it. `paid` and `banked`
   store the same number; the difference between them is payroll's, not
   attendance's.
4. **`half_day` outranks `late`** when a day is both. Both facts survive —
   `late_minutes` is recorded either way — so naming the day by its duration
   loses nothing, while naming it `late` would hide that only half of it was
   worked.
5. **A day actually worked describes itself, whatever the calendar said.**
   Somebody who comes in on a holiday is `present`, not `holiday`; DOCUMENT 12's
   non-working-day confirmation exists precisely so they can.
6. **The admin adjustment reason lives in the audit record.** DOCUMENT 12
   rule 11 requires it; DOCUMENT 06 §3.10 gives the table no column, and
   DOCUMENT 21 is where "why did this change" belongs. Same reasoning as the
   Phase 5 deactivation reason.
7. **A generated row's audit record names the company's designated system
   actor**, created on first use and unable to authenticate. This replaced an
   earlier stand-in (the company's earliest active admin) — see the resolved
   item below.
8. **A schedule missing a weekday row is a configuration fault**, reported and
   skipped per employee, never assumed to be a working day (DOCUMENT 27
   RULE 12).

---

## Open items — for a decision, not built

### ~~The correction window has no configuration home~~ — resolved and built

Answered **"add the minimal company-level persisted setting, default 7"**, and
done. `companies.correction_window_days` is a SMALLINT defaulting to
DOCUMENT 12's own seven days, with a minimum of 1 enforced by a CHECK
constraint that the DTO mirrors — so the same value is refused by the
validator and by the database rather than only by whichever runs first. There
is no maximum: the 1–365 range first built here had an undocumented upper
bound, which the 2026-09-26 critical fix removed (see above).

Zero is excluded deliberately: a window of zero days is not a configuration, it
is switching off the flow DOCUMENT 12 rule 14 depends on as the route a
forgotten check-in takes.

`CorrectionsService` reads the column per request; no constant is left in the
decision path. An administrator sets it on the company settings screen, beside
the other company policies, and it reaches the browser through `GET /auth/me`
so the attendance history knows whether to offer a correction for a given day —
every authenticated user needs that, not only an admin.

### ~~A system actor for generated rows~~ — resolved and built

Answered **"implement the minimal safe non-login system actor per company"**,
and done. `users.is_system` marks it, and four things together mean it can
never authenticate — all of them properties of the database, not promises made
by a service:

1. `auth_lookup_login` does not return system rows. That function is the single
   entry point for both `POST /auth/login` and `POST /auth/forgot-password`
   (DOCUMENT 08 §4.1), so the account is not _refused_ at login, it is
   **invisible** to the code that would do the refusing — which cannot be undone
   by a later change to the service layer.
2. `users_system_has_no_password` refuses any write that would give it a
   password hash. Accepting an invitation is what would otherwise set one.
3. `users_system_is_not_invited` pins its status to `deactivated`, so nothing
   treats it as an account awaiting activation.
4. Without a login there is no session row, so no request can ever run as it.

`users_one_system_actor_per_company` is a partial unique index, which is both
the "exactly one" guarantee and what makes `SystemActorService`'s
find-or-create idempotent: two workers racing produce one row and one caught
unique violation.

The role is the lowest-privilege system role (DOCUMENT 02 §2 `employee`), because
`role_id` is NOT NULL and inventing a fifth role to hold no permissions would be
inventing a role (DOCUMENT 27 RULE 2); nothing ever resolves those permissions,
because nothing can ever run as the account. The address is under `.invalid`,
which RFC 2606 reserves so that it can never resolve.

**`generateRange` no longer takes an actor.** It was a parameter, and a caller
could pass anybody; it now resolves the company's system actor itself, so there
is no longer any way to attribute a generated row to a person. If the actor
cannot be resolved the run is refused and says why — a wrong actor on an audit
record is worse than a run that stops.

### ~~The `auth_lookup_*` functions use an unpinned `search_path`~~ — resolved 2026-09-28

Found 2026-09-27 and fixed by migration
`20260928000000_auth_lookup_search_path`; see "Final pre-Phase 7 hardening"
above.

### ~~Employee profile history panel~~ — built 2026-09-28

See "Final pre-Phase 7 hardening" above.

### Deferred to the phase that owns the table it needs

- **`attendance_records.leave_request_id`** (DOCUMENT 06 §3.10) → **Phase 10**,
  with `leave_requests`. An unenforced UUID now is the shortcut that never gets
  fixed — the reasoning that kept `departments.manager_employee_id` out of
  Phase 4. DOCUMENT 12 rule 8 ("approved leave writes attendance records") is
  Phase 10's to implement; `on_leave` is reachable today through an audited
  admin adjustment, which is how the exit criterion's "every status" is met.
- **`attendance_correction_requests.attachment_id`** (DOCUMENT 06 §3.11) →
  whichever phase builds DOCUMENT 08 §4.14 attachments. DOCUMENT 04 C4 lists the
  attachment as optional; the form does not offer one rather than offering a
  control that cannot store anything (DOCUMENT 27 RULE 26).
- **DOCUMENT 12 rule 12 — "attendance in a finalized payroll period cannot be
  changed"** → **Phase 11**, with `payroll_periods`. There is nothing to check
  against until that table exists. The correction and adjustment paths are the
  only writers, so this becomes one guard in two places when it arrives; it is
  noted here so it is not forgotten.

### Not built, and why

- **"Request more info" on a correction** (DOCUMENT 04 B7). DOCUMENT 08 §4.5
  defines approve, reject and cancel only, and `correction_status`
  (DOCUMENT 06 §3.11) has no state for it. Adding one would be inventing a
  workflow.
- **Export on the daily board** (DOCUMENT 04 B5 "export"). No export endpoint
  exists in DOCUMENT 08 for attendance; Phase 18 owns reporting.
- **The dashboard attendance card** (DOCUMENT 04 C1 component 2). The card
  itself is built and is what `/app/attendance` shows; the _dashboard_ it also
  belongs on is C1, whose other six components are Phases 7, 8, 10, 11 and 12.
  Building the dashboard now would be five "coming soon" panels around one real
  card.
- **Real Redis and a real SMTP relay** were not exercised, because Docker is
  unavailable in this environment. The nightly job's _work_ is tested directly,
  including `runNightly()` itself under `ufuq_app`
  (`attendance-nightly.e2e.test.ts`); what is untested is BullMQ's scheduling
  of it.
- **The product sidebar** — as in Phases 4 and 5, most of its eleven modules do
  not exist yet.
