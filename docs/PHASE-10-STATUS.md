# Phase 10 — Leave management: status

**Roadmap reference:** DOCUMENT 25, Phase 10 (with the Phase 9 amendment: Leave completes its participation in the Requests Centre here)
**Exit criterion:** _approving leave produces correct attendance records and correct balances, and all the conflict cases in DOCUMENT 16 are blocked. Leave participates fully in the unified Requests Centre._

**Status: COMPLETE.** Committed as `Complete Phase 10: Leave Management`.

**Known Phase 11 dependency:** the finalized-payroll-period guard (DOCUMENT 16 rule 12). See "Phase 11 payroll boundary".

## Decisions applied

| Decision                                 | Source                                   | What it means in code                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OD-11 — A**                            | approved                                 | Full days only. Every day count is whole, enforced by the `leave_requests_days_positive_whole` CHECK. The DECIMAL(5,2) balance keeps half days additive later.                                                                                                                     |
| **OD-16 — A**                            | approved                                 | Pro-rated by month worked (`proratedAllowance`).                                                                                                                                                                                                                                   |
| **Proration rounding**                   | approved in this phase (AskUserQuestion) | The joining month counts in full: joining any day of March gives 10 months. The allowance is `default_days_per_year × months ÷ 12`, rounded half away from zero to 2 decimal places. 14 × 10 ÷ 12 = 11.67, 21 × 6 ÷ 12 = 10.50, 21 × 1 ÷ 12 = 1.75. Recorded in DOCUMENT 28 OD-16. |
| **Admin cancellation of approved leave** | approved in this phase                   | Extend `POST /leave-requests/{id}/cancel`. The owner withdraws their own pending request; an ADMIN cancels approved leave. DOCUMENT 08 amended.                                                                                                                                    |
| **Seeded allowances**                    | approved in this phase                   | All five seeded types start at 0 days. An ADMIN sets them in `/admin/settings/leave-types`.                                                                                                                                                                                        |
| **OD-03**                                | Phase 9, authoritative                   | Nobody decides their own leave. A manager's request goes to an ADMIN, an ADMIN-employee's to another ADMIN, on both `/leave-requests` and `/requests`.                                                                                                                             |

There is no open **[DECISION REQUIRED]**. All three questions the documents left open were asked and answered before implementation.

---

## Balance and transaction guarantees

- **The server counts the days** (rule 2).
  - Counted from the employee's own schedule (`work_schedule_days`) and the company's holidays.
  - Weekends are never hardcoded; a schedule missing a weekday is refused, never guessed.
  - The client never sends `days_count`. The whitelist refuses it (422).
- **Exact decimals only.**
  - All day arithmetic goes through `@ufuq/money`'s `Decimal` at scale 2.
  - The repo's lint rule against float arithmetic now also covers the leave code and tests.
- **Remaining is computed, never stored:** `total + carried_over − used − pending`.
- **Soft holds** (rule 3):
  - Submission adds the days to each affected year's `pending_days`.
  - Approval moves them to `used_days`.
  - Rejection and cancellation subtract exactly the days that were held.
  - The days held per year are recorded at submission (`year_allocation`), so release always matches the hold.
  - No column can go negative (`leave_balances_non_negative` CHECK).
- **No overcommitment or double decision.** Every write that touches an employee's leave locks rows in this order with `SELECT … FOR UPDATE`:

  1. the employee row;
  2. the leave request;
  3. each balance row.

  As a result:

  - two submissions for one employee are serialized, so the second sees the first's hold and its overlap;
  - two approvers are serialized, so the second finds the request decided and gets **409 `LEAVE_NOT_PENDING`** (proved with concurrent calls).

- **Approval is one transaction** (rule 4), in this order:
  1. 404 if the request does not exist;
  2. **OD-03** check → 403 `REQUEST_SELF_REVIEW`;
  3. scope check → 403;
  4. take the locks; still pending → otherwise 409;
  5. revalidate:
     - the days still count the same → otherwise 409 `LEAVE_RANGE_CHANGED`;
     - no approved overlap;
     - no check-in on those days;
     - the payroll guard;
  6. move the balance, held → used;
  7. write one `on_leave` attendance day per leave day, `source = system`, `leave_request_id` set:
     - a day already recorded without a check-in (for example, an absence the nightly job wrote) becomes the leave day;
     - that change is audited as `attendance.adjusted_by_admin` (DOCUMENT 12 "Leave approved for past dates");
  8. set the request to approved;
  9. the Requests Centre row follows by trigger;
  10. write `leave.approved`;
  11. commit;
  12. only then is the event published.
- **Forced failure rolls everything back.** Two e2e cases prove it, one with a failing attendance write and one with a failing balance update. Afterwards the request is still pending, the balance unchanged, no attendance day exists, the centre row is pending, there is no audit, and no event.
- **Audit placement:** audit records are written **inside** the transaction, not after commit. This is stricter than the brief's step 12: a decision can never commit without its audit record, and an audit can never describe a change that rolled back. Only the notification **event** waits for the commit (DOCUMENT 19 rule 2).
- **Unpaid types** (rule 7) hold and charge no balance, and have no balance row.
  - The leave record and its `on_leave` days are kept, so Phase 11 Payroll can deduct by the type's `is_paid`.
- **A type that allows a negative balance** (rule 6):
  - the request is accepted;
  - the response carries `warnings: ["exceeds_balance"]` and `excess_days`;
  - the form says the excess is unpaid before submitting;
  - the days are never trimmed;
  - remaining may go negative and is shown that way.

## DOCUMENT 16 conflict cases

| Case                                                      | Handling                                                                                                         | Proof     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------- |
| Insufficient balance                                      | 422 `LEAVE_INSUFFICIENT_BALANCE`. Fields `remaining` and `requested` let the form say "رصيدك المتبقي … والطلب …" | e2e       |
| Overlapping leave (pending or approved)                   | 409 `LEAVE_OVERLAP`, listing the conflicting request and dates                                                   | e2e       |
| All-weekend / non-working range                           | 422 `LEAVE_NO_WORKING_DAYS` ("النطاق المحدد لا يحتوي على أيام عمل")                                              | e2e, unit |
| Missing required attachment                               | 422 `file: required` at field level                                                                              | e2e       |
| Attendance already recorded with a check-in               | 409 `LEAVE_ATTENDANCE_CONFLICT`, listing the date and check-in                                                   | e2e       |
| Start before joining / reversed range / after termination | 422 field errors                                                                                                 | e2e       |
| Duplicate or terminal decision; concurrent approvers      | 409 `LEAVE_NOT_PENDING`                                                                                          | e2e       |
| Self-review                                               | 403 `REQUEST_SELF_REVIEW`                                                                                        | e2e       |
| Leave spanning two months                                 | One record per day, each on its own date                                                                         | e2e, unit |
| Leave spanning two years                                  | Split at the boundary; each year's balance held and charged its own portion, atomically                          | e2e, unit |
| Holiday declared inside approved leave                    | Not recalculated; see below                                                                                      | e2e       |
| Approved leave cancelled                                  | ADMIN, with a reason; see below                                                                                  | e2e       |
| Period finalized                                          | **Phase 11 dependency**; see below                                                                               | —         |

**Holiday inside approved leave.** This is the minimum mechanism the rule needs:

- `POST /holidays` returns `affected_leave_requests`: every approved leave that already has an `on_leave` day on that date.
- The schedules screen lists them in a warning with links.
- The leave detail shows `holidays_inside`.
- Nothing is recalculated. The ADMIN corrects explicitly through the documented balance adjustment, which requires a reason and is audited.

**Approved leave cancelled by an ADMIN** (rule 15):

- **Who:** `leave.approve` at company scope, never on their own leave, with a required reason.
- **Balance:** the used days go back.
- **Attendance:** DOCUMENT 16 says the generated records are deleted. DOCUMENT 06 §6 and DOCUMENT 12 say attendance is never hard-deleted, and the app role has no DELETE. Reconciled as follows:
  - a day that has **ended** is history. It is kept, re-evaluated without the leave (`absent`, or a holiday declared since), and audited;
  - a day **not yet reached** is a projection the leave wrote. It is removed through one narrow `SECURITY DEFINER` function, which refuses anything that is not that leave's own system-written, never-checked-in future day in the caller's company.
- **Audit:** `leave.cancelled` records the reason and both date lists.
- **Employees** cannot cancel approved leave (409).

## Carry-over (rule 13)

- **Job:** `LeaveCarryOverService.runForCompany` / `runAll`, on the existing BullMQ infrastructure.
  - It runs hourly (`leave:carry-over`), so each company turns its year at its own midnight in its own timezone.
  - It runs per company, under that tenant.
- **What it does:** for each of last year's balances whose type is active, paid and set to `full` or `capped` (terminated employees skipped):
  - unused = last year's remaining;
  - `full` carries a positive remainder;
  - `capped` carries at most the cap and forfeits the rest;
  - `none` writes nothing.
- **Writes:** this year's row (created pro-rated if missing) receives `carried_over_days` and is marked `carry_over_applied_at`.
- **Idempotent and safe to rerun.** A marked row is never touched again. A rerun, or the hourly schedule all year, changes nothing and never overwrites a later ADMIN adjustment. Proved: the rerun applies 0, and no further audit records appear.
- **Forfeiture audit.** It is recorded as `leave.balance_adjusted` by the company's system actor, with `carried_over_days`, `forfeited_days`, `from_year`, `from_balance_id` and `reason: "carry_over"`.
  - DOCUMENT 21 has no other leave action, and this one describes what happens: an entitlement change with its consequence.
  - DOCUMENT 21 now says so explicitly.
  - No new action name was invented.
- **Known limit:** the carry is computed once, when the year turns. A request for last year's dates still pending then counts as consumed. If it is later rejected, those days do not flow into the carry, and an ADMIN adjusts explicitly.

## Requests Centre integration (Phase 9 handoff — completed)

| Handoff step                                                                                                                                                                       | Done                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1. `leave_requests` with its own lifecycle                                                                                                                                         | ✅                                                                    |
| 2. AFTER INSERT/UPDATE triggers index it into `requests` (`category = leave`, `related_type = 'leave_request'`). A cancelled row carries no review time, per the `requests` CHECK. | ✅                                                                    |
| 3. The Phase 9 `requests_leave_not_yet_available` refusal replaced by the same-company, same-employee check against `leave_requests`                                               | ✅ (the Phase 9 DB test was updated to the new rule)                  |
| 4. `RequestsService` delegates approve, reject and cancel of a leave row to `LeaveRequestsService`. No leave rule lives in the centre.                                             | ✅ (the e2e shows `leave.approved` written and no `request.approved`) |
| 5. Leave context and balances in the request payload and detail (B13 "leave balance for leave requests")                                                                           | ✅                                                                    |
| 6. Leave offered in C9                                                                                                                                                             | ✅                                                                    |
| 7. Self-review refused in leave approval                                                                                                                                           | ✅                                                                    |

Nothing else needed a separate leave implementation; each piece already handles leave rows:

- the Leave tab;
- filters;
- `pending-count`;
- the `/admin` dashboard KPI and widget (`?reviewable=true`);
- request attachments.

`POST /requests` with `category = leave` is still refused: leave is submitted as a leave request.

## Phase 11 payroll boundary

DOCUMENT 16 rule 12 ("Leave in a finalized payroll period cannot be approved") and its edge cases (a retroactive request, and cancelling approved leave, are blocked if the period is finalized) depend on payroll periods, which are Phase 11. **No payroll table or fake guard was built, and the rule is not claimed as runtime-proven.**

The boundary is exactly one port, already called at the right moments:

- **`LEAVE_PAYROLL_GUARD`** — `LeavePayrollGuard.assertPeriodsOpen(tx, employeeId, dates)`. It is called inside the transaction, before anything changes, by:
  - submission (retroactive requests);
  - approval;
  - an ADMIN's cancellation of approved leave.
- **Phase 10 binding:** `NoPayrollPeriodsGuard`, which allows everything because no payroll period exists yet.
- **Phase 11 requirement:**
  - bind a guard that throws `LEAVE_PERIOD_FINALIZED` (409, already in the error catalogue in both languages: "تم إنهاء كشف رواتب هذه الفترة") when any date falls in a finalized period of the employee's company;
  - add e2e cases for submission, approval and cancellation against a finalized period;
  - nothing else in the leave module changes.
- **Also for Phase 11:**
  - unpaid days are identifiable from the leave type's `is_paid` and the `on_leave` days linked by `leave_request_id`;
  - excess days on a negative-balance type show as a negative remaining.

---

## Database — migration `20261010000000_phase10_leave`

The migration implications required by DOCUMENT 27 RULE 31 are written at the top of the file. It is a new migration and edits no earlier one.

- **New tables:**
  - `leave_types` — soft delete; the cap exists exactly when the policy is `capped`;
  - `leave_balances` — unique `(employee_id, leave_type_id, year)`, non-negative, no stored remaining;
  - `leave_requests` — whole positive days, 3–1000-character reason, review consistency, rejection requires a note, `(company_id, status)` and `(employee_id, start_date)` indexes.
- **`attendance_records.leave_request_id`:**
  - foreign key;
  - must be `on_leave`;
  - same employee and company, enforced by trigger.
- **Same-company triggers** on every new reference.
- **RLS** (ENABLE and FORCE) on the three tables.
- **No DELETE** for the app role.
- **Seeds and triggers:**
  - the five seeded types for every existing company;
  - a `companies` trigger that seeds them for new companies;
  - the leave index triggers;
  - the replaced `requests` same-company function.
- **Attachments:** `related_type` gains `leave_request`.
- **Audit actions:** the seven canonical DOCUMENT 21 leave actions.
- **Columns DOCUMENT 06 does not name**, each needed by a documented rule:
  - `year_allocation` — the two-year split;
  - `carry_over_applied_at` — carry-over idempotency;
  - timestamps.

## API

| Method                | Endpoint                       | Permission                                                                                 |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| GET                   | `/leave-types`                 | settings.view; a `leave.request` holder reads active types                                 |
| POST / PATCH / DELETE | `/leave-types[/{id}]`          | leave.configure_types (DELETE = soft delete)                                               |
| GET                   | `/leave-balances`              | leave.view scope plus own; filters `employee_id`, `leave_type_id`, `year`                  |
| GET                   | `/leave-balances/me`           | authenticated                                                                              |
| PATCH                 | `/leave-balances/{id}`         | leave.adjust_balance · reason required                                                     |
| POST                  | `/leave-requests`              | leave.request · JSON, or multipart with `file`                                             |
| GET                   | `/leave-requests`              | leave.view scope plus own; filters `status`, `leave_type_id`, `employee_id`, `from` / `to` |
| GET                   | `/leave-requests/calculate`    | leave.request                                                                              |
| GET                   | `/leave-requests/{id}`         | scope-checked                                                                              |
| POST                  | `/leave-requests/{id}/approve` | leave.approve                                                                              |
| POST                  | `/leave-requests/{id}/reject`  | leave.approve · reason required                                                            |
| POST                  | `/leave-requests/{id}/cancel`  | own pending; or ADMIN, approved, reason required                                           |

- **Balances are written on first need,** pro-rated. DOCUMENT 05 FLOW 02 creates them with the employee; creating them on first need gives the same result for employees created before Phase 10, and for future years.
- **Adjustments** change only `total_days` and `carried_over_days`:
  - a reason is required;
  - audited with old and new values;
  - refused below the days already used or held, unless the type allows a negative balance;
  - `used_days` and `pending_days` are history and cannot be set (422).
- **Attachments.** A leave request's file is stored inside its own transaction through the generic store's new `prepareUpload` / `storeChecked`.
  - `POST /attachments` uses the same two methods, so storage, type, magic-byte and size checks and the rate limit exist once.
  - Multer limits are shared through `uploadMulterOptions`.
  - Access goes through `LeaveAttachmentPolicy`: view follows the leave's visibility, and the file cannot be replaced afterwards. Another tenant gets 404.
- **Events:** `leave_request_submitted`, `leave_approved`, `leave_rejected` and `leave_cancelled` are published after commit to `LEAVE_EVENT_SINK`. Delivery is Phase 15.

## Web

| Route / place                                                 | What                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/settings/leave-types`                                 | B25: list with allowance, pay, attachment, carry-over and status; create and edit in a dialog; **a confirmation before a change that shapes future balances**; retire (soft delete). A new settings tab, in DOCUMENT 03's order.                                                                                            |
| `/app/requests/new` → Leave                                   | C9 / FLOW 07, described below.                                                                                                                                                                                                                                                                                              |
| `/app/requests`, `/app/requests/:id`, `/admin/requests[/:id]` | Leave rows summarised as type · dates (days). The detail shows type, dates, days (split by year), reason, attachment, the balance table for the affected years, a holiday-inside warning, and the ADMIN's "cancel approved leave" with a reason. Approve and reject use the request's own actions, which the API delegates. |
| `/app` dashboard                                              | C1 component 6: remaining days per type (`/leave-balances/me`), loading on its own.                                                                                                                                                                                                                                         |
| Employee profile → Overview                                   | B4 "leave balance", in `leave.view` scope. The Requests tab lists leave too.                                                                                                                                                                                                                                                |
| Settings → Schedules                                          | After a holiday is added, a warning lists any approved leave it falls inside.                                                                                                                                                                                                                                               |

The C9 leave form contains:

- the type select, with the live balance above the dates;
- native date pickers;
- the **server's** working-day count, which updates as the dates change;
- the impact per year;
- an insufficient-balance block, worded as in DOCUMENT 16;
- an excess-is-unpaid warning, and a note that unpaid leave is deducted by payroll;
- the reason;
- a file picker when the type requires one.

All screens have loading, empty, error and success states.

**Browser-pane check:** the leave-types settings page, the C9 page and `/app`, in `ar` and `en` at 375px, on the production build. There was no horizontal scroll, and the settings tab appears in the documented position. No API runs here, so the data areas showed their error states; the populated layouts were not seen with data.

## Documentation amendments

| Document          | Amendment                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 08 — §4.2         | `PATCH/DELETE /leave-types/{id}` (leave.configure_types; DELETE is a soft delete). The GET note says a `leave.request` holder reads active types.            |
| 08 — §4.6         | `POST /leave-requests/{id}/cancel`: own pending; or an ADMIN (`leave.approve` at company scope, never their own) cancelling approved leave, reason required. |
| 21 — Leave        | The carry-over and its forfeiture are recorded as `leave.balance_adjusted` by the system actor.                                                              |
| 28 — OD-11, OD-16 | Recorded as decided (A); OD-16 with the exact month-count and rounding rule.                                                                                 |

## Interpretations made

1. **Unpaid types have no balance** (rule 7): no hold, no charge, no row.
2. **Overlap counts pending and approved leave of any type** (rule 10 plus "prevent double holds").
3. **An approval whose day count no longer matches the hold is refused** (409 `LEAVE_RANGE_CHANGED`). This happens when the schedule or holidays changed since submission. Approving different days than were held would break the hold guarantee; the employee cancels and resubmits.
4. **A retroactive request is allowed** with every other check applied. DOCUMENT 16's "configurable window" has no configuration field in the documents, so none was invented. The finalized-period half is the Phase 11 guard.
5. **`GET /leave-types` for `leave.request`.** DOCUMENT 08 gives the list to `settings.view`, but a requester must choose a type, so `leave.request` holders read active types only.
6. **B3's per-employee allowance field** (employee form) is not added. A per-employee entitlement is set with the documented balance adjustment, which requires a reason and is audited.

## Deferred by phase

| Item                                                    | Why                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Finalized-payroll blocking (rule 12 and its edge cases) | Phase 11 — see "Phase 11 payroll boundary"                                                         |
| Payroll deduction for unpaid and excess days            | Phase 11 (DOCUMENT 15)                                                                             |
| Notification delivery for leave events                  | Phase 15 — events are published after commit                                                       |
| B1 KPI "On leave" (row 1) and the other people KPIs     | The B1 attendance KPIs belong with the dashboard work they share, not with Phase 10's leave domain |
| Team leave calendar, half-day leave, encashment         | DOCUMENT 16 "Future extensions"; OD-11 A; OD-08                                                    |

---

## Verification results

| Command                       | Result                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | Pass                                                                                           |
| `turbo run lint --force`      | Pass — 0 errors; the same 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts` |
| `turbo run typecheck --force` | Pass — 15/15                                                                                   |
| `turbo run test --force`      | Pass — 15/15, **1278 tests**                                                                   |
| `turbo run build --force`     | Pass — 8/8; `/admin/settings/leave-types` prerenders in `ar` and `en`                          |
| `pnpm verify`                 | Not run — it needs real PostgreSQL and Redis                                                   |

The affected suites ran first:

- `phase10-rls`, plus `phase9-rls` (updated);
- `leave-rules`, `leave.e2e`;
- `requests.e2e`, `attendance.e2e`, `attachments.e2e`, `company-structure.e2e`;
- web `leave`, `requests`, `settings-nav`;
- i18n parity.

The full set ran after them.

| Package        | Tests    | Phase 10 additions                                                            |
| -------------- | -------- | ----------------------------------------------------------------------------- |
| `packages/db`  | 243      | **+22** — `test/phase10-rls.test.ts`                                          |
| `apps/api`     | 717      | **+46** — `test/leave.e2e.test.ts` (30), `src/leave/leave-rules.test.ts` (16) |
| `apps/web`     | 205      | **+8** — `lib/leave.test.ts`, one `requests` case                             |
| other packages | 113      | — (i18n parity covers the new keys in both languages)                         |
| **Total**      | **1278** | **+76** (1202 at the end of Phase 9)                                          |

**Web test coverage note:** as in earlier phases, the web package has no component-rendering harness. The leave form's rules are unit-tested in `lib/leave.ts`:

- the calculate query, and that no day count is ever sent;
- the multipart body;
- validation;
- the leave-type form and its future-calculation warning.

Behaviour is proven end to end in the API suite.
