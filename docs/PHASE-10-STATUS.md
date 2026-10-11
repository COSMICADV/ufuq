# Phase 10 — Leave management: status

**Roadmap reference:** DOCUMENT 25, Phase 10 (with the Phase 9 amendment: Leave completes its participation in the Requests Centre here)
**Exit criterion:** _approving leave produces correct attendance records and correct balances, and all the conflict cases in DOCUMENT 16 are blocked. Leave participates fully in the unified Requests Centre._

**Status: COMPLETE.** Committed as `Complete Phase 10: Leave Management`.

**Known Phase 11 dependency:** the finalized-payroll-period guard (DOCUMENT 16 rule 12). See "Phase 11 payroll boundary". It is the only Phase 10 dependency on a later phase.

**Corrective pass:** `Fix Phase 10 audit and attendance invariants`, on top of `3c8d9aa`. It fixes two architecture violations: leave audits are now written after commit, and attendance rows are never hard-deleted. See "Phase 10 corrective pass".

## Decisions applied

| Decision                                 | Source                                   | What it means in code                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OD-11 — A**                            | approved                                 | Full days only. Every day count is whole, enforced by the `leave_requests_days_positive_whole` CHECK. The DECIMAL(5,2) balance keeps half days additive later.                                                                                                                     |
| **OD-16 — A**                            | approved                                 | Pro-rated by month worked (`proratedAllowance`).                                                                                                                                                                                                                                   |
| **Proration rounding**                   | approved in this phase (AskUserQuestion) | The joining month counts in full: joining any day of March gives 10 months. The allowance is `default_days_per_year × months ÷ 12`, rounded half away from zero to 2 decimal places. 14 × 10 ÷ 12 = 11.67, 21 × 6 ÷ 12 = 10.50, 21 × 1 ÷ 12 = 1.75. Recorded in DOCUMENT 28 OD-16. |
| **Admin cancellation of approved leave** | approved in this phase                   | Extend `POST /leave-requests/{id}/cancel`. The owner withdraws their own pending request; an ADMIN cancels approved leave. DOCUMENT 08 amended.                                                                                                                                    |
| **Seeded allowances**                    | approved in this phase                   | All five seeded types start at 0 days. An ADMIN sets them in `/admin/settings/leave-types`.                                                                                                                                                                                        |
| **OD-03**                                | Phase 9, authoritative                   | Nobody decides their own leave. A manager's request goes to an ADMIN, an ADMIN-employee's to another ADMIN, on both `/leave-requests` and `/requests`.                                                                                                                             |

There is no open **[DECISION REQUIRED]**. All three questions the documents left open were asked and answered before implementation. The corrective pass raised two more, and both were answered before it was implemented:

- the post-commit audit mechanism: a shared dispatcher on the existing writer, used by Leave;
- the state of a today/future working-day row when approved leave is cancelled: `pending`, which the nightly job converts.

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
  10. commit;
  11. then the audit records (`leave.approved`, plus any `attendance.adjusted_by_admin`) are dispatched;
  12. then the event is published.
- **Forced failure rolls everything back.** Two e2e cases prove it, one with a failing attendance write and one with a failing balance update. Afterwards the request is still pending, the balance unchanged, no attendance day exists, the centre row is pending, there is no audit, and no event.
- **Audit placement: after commit** (DOCUMENT 21 §1–§3). Every leave write collects its audit entries while its transaction runs. It hands them to `AuditDispatcher` only after the commit, and publishes the event after that. A rollback therefore writes no audit. A failed audit write is retried, and it never undoes the committed action. See "Phase 10 corrective pass".
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
- **Attendance: reconciled, never deleted.** Attendance records are never hard-deleted (DOCUMENT 06 §6, DOCUMENT 12; DOCUMENT 16 rule 15 corrected). Every row the leave wrote is kept with the same id. Its `leave_request_id` is cleared and its `on_leave` state replaced by the state the day has without the leave (`dayWithoutLeave`, in the attendance calculation module):
  - **before today, a working day:** `absent`, with the minutes the nightly absence job writes;
  - **any day that is now a holiday or rest day**, past or future: `holiday` / `weekend`, from the schedule and holiday configuration;
  - **today or later, a working day:** `pending`, with no check-in and `source = system`. This was a **[DECISION REQUIRED]**, approved in the corrective pass. The day has not happened, so it is not an absence yet. Checking in converts the row, as it converts any generated row. If nobody checks in, the nightly job turns it into `absent` once the day has ended;
  - **real check-in/check-out data is never overwritten.** If a row has times, they are kept and they decide the status.
  - Each reconciled row is audited as `attendance.adjusted_by_admin`, old and new, after commit.
- **Audit:** `leave.cancelled` records the reason and `reconciled_days` (date → new status), after commit.
- **One transaction**, in this order:

  1. authorization: `leave.approve` at company scope;
  2. no self-review (OD-03);
  3. the request and employee locks;
  4. still approved;
  5. the payroll-period guard, for the leave's days;
  6. the balance locks;
  7. used days reversed;
  8. attendance reconciled, with no DELETE;
  9. request set to `cancelled`;
  10. the Requests Centre row follows by trigger;
  11. commit.

  Only then come the `leave.cancelled` audit and the `leave_cancelled` event. A forced failure at the attendance step or the request-status step leaves everything unchanged: request, balance, attendance rows (compared field by field), centre row, audits, events and the retry queue (e2e).

- **Employees** cannot cancel approved leave (409).

## Phase 10 corrective pass

### 1. Audit after commit

The Phase 10 brief said to reuse "the existing post-commit audit infrastructure", but **none existed**. Phases 3–9 all write audit inside the business transaction with `AuditService.record(tx, …)`, and there was no audit retry or fallback anywhere. With approval, the corrective pass added one post-commit path on top of the single existing writer. No second writer was created.

- **`AuditDispatcher`** (`apps/api/src/auth/audit-dispatcher.ts`, provided and exported by `AuthModule`):
  - `dispatch(entries)` is called only after the business transaction has returned, meaning it committed. It never throws.
  - Each entry is written with `AuditService.record` in its own short tenant transaction.
  - The record's id and time are fixed at dispatch. A retry therefore cannot duplicate the record (a unique violation on that id means an earlier attempt landed), and the record keeps the time the action committed.
- **Retry:** a failed write goes to `AUDIT_RETRY_QUEUE`:
  - `BullMqAuditRetryQueue` runs on the existing Redis (AD-01), queue `audit`, job id = record id;
  - 10 attempts with exponential backoff, failed jobs kept;
  - `AuditRetryWorker` drains it and is registered wherever background jobs run.
- **Fallback:** if the enqueue also fails, or a job runs out of retries, the full entry is logged at error level with the prefix `AUDIT_FALLBACK`. It is never dropped silently (DOCUMENT 21 §2).
- **Moved to post-commit:** every audit the leave module writes:
  - `leave.requested`, `leave.approved`, `leave.rejected`, `leave.cancelled` (both the requester's withdrawal and an ADMIN's cancellation);
  - `leave.balance_adjusted`, both the ADMIN adjustment and the carry-over's system-actor record;
  - `leave_type.created`, and `leave_type.updated` (including retire);
  - the `attendance.adjusted_by_admin` records that approval and cancellation write;
  - the `attachment.uploaded` of a file submitted with a leave request (`storeChecked` gained an optional post-commit list; `/attachments` is unchanged).
- **Order on success:** business transaction → COMMIT → audit dispatch → event publish.
- **Known divergence, not changed in this pass:** the modules of Phases 3–9 still audit inside their own transactions. For them, a rollback still writes no audit. But a failed audit write rolls back their action, which DOCUMENT 21's edge case does not allow. Moving them onto `AuditDispatcher` is mechanical (the same collect-then-dispatch pattern). It was left out of this pass because the brief limits it to Phase 10.

### 2. Attendance never hard-deleted

- The cancellation path no longer deletes anything. See "Approved leave cancelled by an ADMIN" above for the exact reconciliation.
- The `SECURITY DEFINER` delete function is dropped. Phase 6's REVOKE is the only DELETE rule for `attendance_records`, and it allows no delete at all.
- **Nightly job** (`AttendanceGenerationService`): it gained one conditional step. A `system` row that is `pending`, with no check-in and no leave, becomes what an unrecorded day becomes (`absent`, or the calendar status) once its day has ended. It is audited as `attendance.generated_by_system`. Rows for a forgotten check-out have a check-in, so they are untouched.

### Proof (added tests)

| Guarantee                                                                                                                                                                                                  | Test               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Forced rollback of an approved-leave cancellation (two failure points) leaves request, balance, attendance rows, centre row unchanged; no `leave.cancelled` or attendance audit, no event, nothing queued  | `leave.e2e`        |
| A successful approval is already committed (visible from another connection) when its audit is dispatched; no audit row and no event exist at that moment; the event follows the audit                     | `leave.e2e`        |
| A failed audit write (forced DB failure on `audit_logs`) keeps the approval: status, centre row, attendance and balance stand; the entry is queued; the retry write lands exactly once even when run twice | `leave.e2e`        |
| Retry queue also down → `AUDIT_FALLBACK` error log with the full entry; the rejection stands                                                                                                               | `leave.e2e`        |
| Cancellation keeps all five rows (same ids): 2 past days `absent`, today and later `pending`; check-in converts today's; the nightly job turns an ended one `absent`                                       | `leave.e2e`        |
| Leave attachment's `attachment.uploaded` audit is written (post-commit)                                                                                                                                    | `leave.e2e`        |
| `DELETE` on `attendance_records` as `ufuq_app` is refused (with and without `WHERE`); the old function no longer exists; no function in `pg_proc` deletes from it; in-place reconciliation still works     | `phase10-rls`      |
| `dayWithoutLeave`: past → absent; today/future working → pending; holiday/rest → calendar status; real times kept                                                                                          | `calculation.test` |

---

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
- **Forfeiture audit.** It is recorded as `leave.balance_adjusted` by the company's system actor, with `carried_over_days`, `forfeited_days`, `from_year`, `from_balance_id` and `reason: "carry_over"`. It is written after the company's carry commits.
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
- **Attendance hard-delete path removed** (corrective migration `20261011000000_phase10_attendance_never_deleted`). It drops `attendance_remove_future_leave_day`, the `SECURITY DEFINER` function the Phase 10 migration had added, and restates Phase 6's `REVOKE DELETE ON attendance_records FROM ufuq_app`. No other database function deletes from `attendance_records`, and a test checks `pg_proc` to prove it.
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

| Document                 | Amendment                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 08 — §4.2                | `PATCH/DELETE /leave-types/{id}` (leave.configure_types; DELETE is a soft delete). The GET note says a `leave.request` holder reads active types.                                                                          |
| 08 — §4.6                | `POST /leave-requests/{id}/cancel`: own pending; or an ADMIN (`leave.approve` at company scope, never their own) cancelling approved leave, reason required.                                                               |
| 21 — Leave               | The carry-over and its forfeiture are recorded as `leave.balance_adjusted` by the system actor.                                                                                                                            |
| 28 — OD-11, OD-16        | Recorded as decided (A); OD-16 with the exact month-count and rounding rule.                                                                                                                                               |
| 16 — rule 15, edge cases | Corrective pass: approved-leave cancellation reverses the balance and reconciles the system-generated attendance records back to their correct non-leave state. Attendance records are never hard-deleted.                 |
| 12 — edge cases          | Corrective pass: "Approved leave cancelled": past working day → `absent`; holiday or rest day → calendar status; today or later working day → `pending` until checked into or ended, then the nightly job writes `absent`. |

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

After the corrective pass. The affected suites ran first: `phase10-rls`, `leave.e2e`, `calculation`, `requests.e2e`, `attachments.e2e`, and the whole API package. The full set ran after them.

| Command                        | Result                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm format` / `format:check` | Pass                                                                                        |
| `turbo run lint --force`       | Pass: 0 errors. The same 4 `no-console` warnings as before, in `packages/db/prisma/seed.ts` |
| `turbo run typecheck --force`  | Pass: 15/15                                                                                 |
| `turbo run test --force`       | Pass: 15/15, **1289 tests**                                                                 |
| `turbo run build --force`      | Pass: 8/8. `/admin/settings/leave-types` prerenders in `ar` and `en`                        |
| `pnpm verify`                  | Not run. It needs real PostgreSQL and Redis                                                 |

| Package        | Tests    | Phase 10 additions                                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`  | 246      | **+25**: `test/phase10-rls.test.ts`. The corrective pass replaced the removal-function case with 4 no-delete cases        |
| `apps/api`     | 725      | **+54**: `test/leave.e2e.test.ts` (34), `src/leave/leave-rules.test.ts` (16), `dayWithoutLeave` in `calculation.test` (4) |
| `apps/web`     | 205      | **+8**: `lib/leave.test.ts`, plus one `requests` case                                                                     |
| other packages | 113      | None added. i18n parity covers the new keys in both languages                                                             |
| **Total**      | **1289** | **+87** (1202 at the end of Phase 9; 1278 at `3c8d9aa`)                                                                   |

**Web test coverage note:** as in earlier phases, the web package has no component-rendering harness. The leave form's rules are unit-tested in `lib/leave.ts`:

- the calculate query, and that no day count is ever sent;
- the multipart body;
- validation;
- the leave-type form and its future-calculation warning.

Behaviour is proven end to end in the API suite.
