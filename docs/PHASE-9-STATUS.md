# Phase 9 — Requests: status

**Roadmap reference:** DOCUMENT 25, Phase 9 (amended in this phase — see "Documentation amendments")
**Exit criterion (approved):** _Attendance, Salary, Task and General requests can each be submitted, reviewed, approved, rejected, and cancelled, with reasons enforced. The Leave category exists in the unified centre as an integration boundary; Leave's specialised lifecycle is completed in Phase 10._

**Status: COMPLETE** under the approved Leave roadmap clarification. Committed as `Complete Phase 9: Requests`.

| Category   | Submitted                                               | Reviewed / approved / rejected (reason enforced)            | Cancelled (own, pending)    |
| ---------- | ------------------------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| Salary     | ✅ `POST /requests`                                     | ✅                                                          | ✅                          |
| Task       | ✅ `POST /requests` (optional task, in task scope)      | ✅                                                          | ✅                          |
| General    | ✅ `POST /requests`                                     | ✅                                                          | ✅                          |
| Attendance | ✅ as a correction (C4 form, `/attendance-corrections`) | ✅ in the centre, delegated to the Phase 6 correction logic | ✅ in the centre, delegated |
| Leave      | Integration boundary only — Phase 10                    | Phase 10                                                    | Phase 10                    |

**Proof:**

- `apps/api/test/requests.e2e.test.ts` — 24 tests over HTTP, against real PostgreSQL with RLS.
- `packages/db/test/phase9-rls.test.ts` — 21 tests.

---

## Approved decisions

### 1 — Leave boundary (Option A, approved)

Phase 9 does not build the Leave domain, and it has no generic Leave submission. The OD-09 hybrid model stays authoritative:

- attendance corrections keep their specialised records;
- leave requests keep their specialised records (Phase 10);
- `requests` is the unified inbox row;
- salary, task and general requests live directly in `requests`.

**What exists for Leave now (the integration boundary):**

- **Category.** `leave` is in the `request_category` enum (DOCUMENT 06 §3.20).
- **Shape.** The table's CHECK requires a leave row to point at a `leave_request`.
- **Database guard.** The same-company trigger refuses any leave row (`requests_leave_not_yet_available`) until Phase 10 replaces that clause, so no path can write a fake leave row.
- **API.** `POST /requests` with `category = leave` returns 422 `REQUEST_CATEGORY_SPECIALISED`.
- **Inbox.** The **Leave** tab stays visible in B13. It shows an empty state until Phase 10 indexes leave requests.
- **Form.** The submission form offers no Leave option (RULE 26).

### 2 — OD-03 when the only ADMIN is the requester (approved V1 fallback)

Self-review is **never** allowed. There is no secondary-approver setting, and no temporary review power for a MANAGER.

**Who is blocked:** a manager, and an ADMIN who is also an employee. Neither can approve or reject their own request.

**Where it is enforced:**

- `RequestsService` refuses it with 403 `REQUEST_SELF_REVIEW`.
- `requestReviewableWhere` excludes the caller's own requests (used by the pending count and `?reviewable=true`).
- The shared `CorrectionsService.requirePending` refuses it too, so `/attendance-corrections/{id}/approve` refuses it as well.

**When the requester is the only eligible ADMIN:**

- the request can still be submitted;
- it stays **Pending**;
- the requester may **cancel** it while it is pending;
- it can be reviewed once another eligible ADMIN exists.

**UI:** the detail shows "This is your own request" with this explanation, in Arabic and English.

**Proved by these `requests.e2e` tests:**

- "a manager cannot approve or reject their own request; an ADMIN can"
- "an ADMIN who is also an employee cannot decide their own request; another ADMIN can"
- "the same rule holds for attendance corrections, on both endpoints"
- "OD-03 V1 fallback". This test runs in a company whose only ADMIN is also an employee, and checks that:
  - the request stays pending;
  - the pending count is 0 and the reviewable list is empty;
  - another company's ADMIN gets 404;
  - the requester can cancel;
  - after a second ADMIN is invited and activated, that admin reviews and approves it.

### 3 — Request audit actions (approved, now canonical)

DOCUMENT 21 now lists `request.submitted`, `request.approved`, `request.rejected` and `request.cancelled` under "Requests". The code uses exactly those names. Attendance corrections keep `attendance.correction_requested`, `attendance.correction_approved` and `attendance.correction_rejected`. A correction cancelled by its requester is recorded as `request.cancelled`, which DOCUMENT 21's Requests group now covers ("the requester's cancellation of a request"). DOCUMENT 21 has no attendance cancellation action.

## Documentation amendments

| Document                   | Amendment                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **25 — Roadmap, Phase 9**  | The exit now reads: Attendance, Salary, Task and General complete their lifecycle (submitted, reviewed, approved, rejected, cancelled, with reasons enforced). The Leave category exists as an integration boundary. Leave's specialised lifecycle completes in Phase 10. A note records the approved roadmap clarification.                                                                                   |
| **25 — Roadmap, Phase 10** | The description adds that leave requests are indexed into the Requests Centre the same way corrections are, with the centre's decisions delegated to the leave logic. The exit adds full Leave participation in the Requests Centre: submitted, reviewed, approved, rejected and cancelled there, with reasons enforced. That completes Phase 9's exit for Leave.                                              |
| **28 — OD-03**             | "Decision (approved, Phase 9): A". It records the V1 fallback: an only-ADMIN requester's request may be submitted, stays Pending, may be cancelled, and is reviewable only once another eligible ADMIN exists; there is no secondary-approver setting and no temporary MANAGER review power. This replaces the reference to an undefined secondary-approver configuration. The summary table marks it decided. |
| **21 — Audit**             | A new "Requests" group lists the four `request.*` actions, with a note that specialised records keep their own actions.                                                                                                                                                                                                                                                                                        |

## Phase 10 Leave handoff

The integration pattern for Leave is already in place for attendance corrections, and Phase 10 copies it.

1. **Create `leave_requests`** with its own lifecycle (DOCUMENT 06 §3.14, DOCUMENT 16).
2. **Index it into `requests`.** Add `AFTER INSERT` and `AFTER UPDATE` triggers on `leave_requests`, mirroring `attendance_correction_index_request()`:
   - `category = 'leave'`, `related_type = 'leave_request'`, `related_id = leave_requests.id`;
   - status, reviewer, review time and `review_note` (written to `admin_response`) follow the leave record;
   - backfill any existing rows.
3. **Replace the leave clause of `requests_enforce_same_company()`.** The `requests_leave_not_yet_available` refusal becomes a same-company, same-employee check against `leave_requests`, as for corrections.
4. **Delegate in `RequestsService`.** In `decide` and `cancel`, add a branch for `related_type = 'leave_request'` that calls the leave service, as the attendance branch calls `CorrectionsService`. Leave keeps its `leave.*` audit actions and its single transaction (balance, hold and attendance records).
5. **Payload.** Add the leave record to `RequestPayload`, as `attendance` is today. B13's "leave balance for leave requests" goes in the detail.
6. **Form.** Offer Leave in C9 (`request-form.tsx`), linking to the leave form or embedding it, as Attendance links to C4.
7. **Self-review.** Make the leave approval refuse self-review (OD-03), as `CorrectionsService.requirePending` does.

Done this way, the inbox, Leave tab, filters, pending count, dashboard widget and attachments all need no change.

---

## Database — migration `20261008000000_phase9_requests`

The migration implications required by DOCUMENT 27 RULE 31 are written at the top of the file. It is a new migration and edits no earlier one.

- **`requests`** (DOCUMENT 06 §3.20):
  - Columns: `id`, `company_id`, `employee_id`, `category`, `subject`, `description`, `related_type`, `related_id`, `status`, `reviewed_by`, `reviewed_at`, `admin_response`, `created_at`.
  - New enums: `request_category` and `request_status`.
  - The documented index `(company_id, status, created_at)`, plus `(employee_id, created_at)` for C8.
  - One inbox row per specialised record: unique `(related_type, related_id)`.
- **CHECK constraints:**
  - the `related_type` / `related_id` pair is both set or both null;
  - **per-category shape (OD-09)**:
    - attendance → `attendance_correction_request`;
    - leave → `leave_request`;
    - task → nothing, or a `task`;
    - salary and general → nothing;
    - native categories need a subject and a description;
  - a decision has a time, and an open request has none;
  - **a rejection has a reason**;
  - length bounds.
- **Same-company trigger.** It covers `employee_id`, `reviewed_by` and the polymorphic `related_id`:
  - a task must be in the same company;
  - a correction must be in the same company **and belong to the same employee**;
  - leave is refused until Phase 10.
- **Hybrid index (OD-09).**
  - `AFTER INSERT` and `AFTER UPDATE` triggers on `attendance_correction_requests` write and keep its inbox row, in the same transaction, as the calling role. So RLS applies.
  - Every existing correction is backfilled with a UUID v7 key (OD-12).
- **Attachments.** `attachments.related_type` CHECK widened to `('task', 'request')`.
- **Least privilege.** The app role gets SELECT, INSERT and UPDATE. **No DELETE**: requests are history.
- **RLS.** `tenant_isolation`, ENABLE and FORCE.
- **Audit actions.** `audit_action` gains `request.submitted`, `request.approved`, `request.rejected` and `request.cancelled` (see interpretation 4).

## API — DOCUMENT 08 §4.9, exactly

| Method | Endpoint                  | Permission                                                                                                                  |
| ------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/requests`               | `request.view` scope, plus own. Filters: category, status, employee_id, from/to; `reviewable=true` (needs `request.review`) |
| POST   | `/requests`               | `request.create` (always the caller's own)                                                                                  |
| GET    | `/requests/pending-count` | as list                                                                                                                     |
| GET    | `/requests/{id}`          | scope-checked                                                                                                               |
| POST   | `/requests/{id}/approve`  | `request.review`; optional `admin_response`                                                                                 |
| POST   | `/requests/{id}/reject`   | `request.review`; `admin_response` **required**                                                                             |
| POST   | `/requests/{id}/cancel`   | `request.cancel`; own, pending only                                                                                         |

Pagination is DOCUMENT 08 §1's. `from` and `to` are calendar days in the company's timezone, inclusive.

- **Scope** (DOCUMENT 02, DOCUMENT 09 §4):
  - an employee sees their own requests;
  - a manager sees their team's, plus their own (`team` excludes self);
  - an admin sees the whole company.
  - Filters are AND-ed with scope, so a manager filtering by an outsider gets nothing.
  - Another company's request is **404**. An in-tenant request outside reach is 403, as for goals and corrections.
- **Decisions** run checks in this order: exists (404) → in `request.review` scope (403) → not own (403 `REQUEST_SELF_REVIEW`) → pending (409 `REQUEST_NOT_PENDING`).
  - The native update is conditional on `status = 'pending'`, so concurrent reviewers cannot both decide.
  - Terminal states reject every repeated decision, and reject cancellation.
- **Native categories:**
  - Approval records the reviewer, `reviewed_at` and `admin_response`, and **changes nothing else**. No salary, task or payroll effect is invented.
  - A task request may name a task. It must be visible in the requester's `task.view` scope; another company's task, or a colleague's, is `task_id: not_found`.
- **Attendance:**
  - `POST /requests` with `category = attendance` is 422 `REQUEST_CATEGORY_SPECIALISED`. The correction is filed through its own endpoint, which indexes itself.
  - Approve, reject and cancel in the centre **delegate to `CorrectionsService`**: its recalculation, its single transaction, its `attendance.correction_*` audit actions. The inbox row follows by trigger.
  - A decision made on `/attendance-corrections` shows up in the centre automatically.
- **Pending count:**
  - For a reviewer (`basis: review`): the pending requests they can decide, excluding their own.
  - Otherwise (`basis: own`): their own pending requests.
- **Attachments.** `RequestAttachmentPolicy` is registered with the Phase 7 store. No storage code is duplicated, and the store's type, size, magic-byte, private-object and rate-limit checks all apply. The policy:
  - view = the request is visible to the caller (otherwise 404, including across tenants);
  - upload and delete = the requester, on their own **pending** request only.
- **Audit:**
  - Native requests use `request.submitted`, `request.approved`, `request.rejected` and `request.cancelled`, with only changed fields.
  - Corrections keep their canonical actions.
  - Correction cancellation is now audited as `request.cancelled`, because DOCUMENT 21 has no attendance cancellation action.
- **Events.** `request_submitted` and `request_reviewed` (DOCUMENT 19) are published **after commit** to a `REQUEST_EVENT_SINK` port. The deferred sink logs only. Phase 15 replaces it with delivery.

**`reviewable=true`** is the one filter beyond DOCUMENT 08 §4.9. It narrows the list to the requests the caller may decide: their `request.review` scope, never their own. That is the same population as the pending count. The B1 widget needs it to list "actionable" requests. The precedent is `GET /tasks?needs_reassignment=true` (Phase 7).

**Bug fixed during completion:** for an ADMIN who is also an employee, visibility was built as `OR: [{}, own]`. Prisma treats `{}` inside `OR` as matching nothing, so that ADMIN saw only their own requests. This also affected request attachments, which use the same rule. Company scope now returns `{}` directly. A unit test and the `reviewable` e2e test cover it.

## Web

| Route                                      | Screen                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/requests`                          | B13 inbox: tabs All / Attendance / Leave / Salary / Task / General; status filter defaulting to **Pending** (with "All statuses"); employee and submitted-date filters; pagination. Everything is in the URL. Row: employee, category chip, summary, submitted date, age indicator, status.                                                                                                                                                                               |
| `/admin/requests/:id`, `/app/requests/:id` | B13 detail / C10, described below.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/app/requests`                            | C8: own history, with category, status and date.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/app/requests/new`                        | C9: a category selector for salary, task and general, with subject, description and an optional own task. Attendance links to the existing C4 correction form. Leave is not offered.                                                                                                                                                                                                                                                                                      |
| `/app` dashboard                           | C1 component 7: the requests pending count (`GET /requests/pending-count`), with its own loading and error states.                                                                                                                                                                                                                                                                                                                                                        |
| `/admin` dashboard                         | B1 KPI row 2 "Pending requests" (`pending-count`, review basis). B1 widget 7 "Pending requests": the 5 most recent the caller may decide (`?status=pending&reviewable=true`), each with inline **Approve**, and **Reject** through a small dialog that requires a reason. Both use the normal `/requests/{id}/approve` and `/reject` endpoints, and a decision refreshes the KPI. Shown only to a caller with `request.review`; each loads, fails and retries on its own. |
| Employee profile → Requests tab            | B4: this employee's requests, replacing the empty placeholder.                                                                                                                                                                                                                                                                                                                                                                                                            |

The request detail (B13 / C10) contains:

- the complete request;
- employee context;
- the linked task;
- the attendance context, shown as current against requested values;
- the decision: reviewer, time and response;
- approve and reject with a response field, where reject requires it;
- an OD-03 self-review notice;
- cancel with confirmation, only while the request is pending and only for its owner;
- attachments;
- the decision history, from the audit log.

**Reuse, not copies:**

- `CorrectionComparison` was extracted from the corrections screen, which now uses it too.
- The attachments card takes a `relatedType`.
- The status and category chips use existing tones.
- The table is shared by the inbox, C8 and the profile tab.

**States:** loading, empty (including a distinct filtered-empty state), error with retry, and success on every screen.

**Browser-pane check:** `ar` (RTL) and `en` (LTR) at 375px, on the production build, with no horizontal scroll.

- The tabs scroll horizontally, and clicking a tab updates the URL (`?category=salary`) with the status still Pending.
- No API runs here, so the data areas showed their error state with retry. The populated layouts were not seen with data.

---

## Interpretations made

1. **Visibility = scope + own.**
   - A manager's `team` scope excludes themselves, but C8 is every submitter's own history.
   - Being the requester always lets you **see** a request, as with corrections in DOCUMENT 08 §4.5. It never lets you **decide** it.
2. **In-tenant, out-of-scope = 403.** DOCUMENT 09 §4, as for goals and corrections. Another company's request is 404.
3. **The attendance index is maintained by database triggers**, not application code. So no path can write or decide a correction without its inbox row following, and corrections created before Phase 9 are backfilled.
4. **Request audit actions** are now canonical in DOCUMENT 21 (approved decision 3).
   - Denied self-review attempts are **not** audited as `permission.denied`: no existing code path records denials, and the existing audit rules do not require it.
5. **`admin_response` is the rejection reason.** DOCUMENT 06 has one column for it, and B13 calls it the "response field". Its bound is 1000 characters, the same as correction review notes.
6. **The age indicator** counts whole days since submission in the company's calendar. It is text only; no threshold colours are invented.
7. **Task requests reference a task only optionally.** When one is named, normal `task.view` scope applies.
8. **Request attachments** are added by the requester while the request is pending. Reviewers read them; nobody edits a decided request's files.
9. **`created_at` uses the application clock**, as Phase 8's goal history does. It is the same clock as the date filter and the decision times.

## Changes to earlier phases (necessary, minimal)

- **`CorrectionsService`** (Phase 6):
  - **Self-review refusal (OD-03)**: before this, a company-scoped ADMIN could approve their own correction.
  - Cancellation is now audited.
  - `cancel` takes the request origin for that audit record.
  - The Phase 6 suite still passes (80 tests).
- **`TaskAttachments`**: gained `relatedType`, and its prop is renamed `taskId` → `recordId`. There is one caller.
- **`corrections-list.tsx`**: uses the extracted `CorrectionComparison`. The markup is unchanged.
- **`SessionView`**: gained `employeeId`, from `/auth/me`'s `employee`.
- **`PERSON_SELECT`** in `task-payload.ts` is now exported, for the reviewer reference.

## Deferred by phase

| Item                                                                                      | Why                                                                        |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Leave's specialised lifecycle in the centre; the leave balance in the request detail      | Phase 10, by the approved roadmap amendment — see "Phase 10 Leave handoff" |
| Notification delivery (`request_submitted`, `request_reviewed`, correction notifications) | Phase 15 — events are published after commit to `REQUEST_EVENT_SINK`       |
| The other B1 KPIs and widgets (attendance, tasks, payroll, inventory…)                    | Their modules' phases; only the requests KPI and widget belong to Phase 9  |
| Correction "More info" (FLOW 06) and payroll-finalised blocking                           | Not Phase 9; payroll is Phase 11                                           |
| Correction attachments (`attachment_id` in DOCUMENT 06 §3.11)                             | Out of Phase 9's scope; the request-level attachments are built            |

---

## Verification results

| Command                       | Result                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | Pass                                                                                                                            |
| `turbo run lint --force`      | Pass — 0 errors; the same 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`                                  |
| `turbo run typecheck --force` | Pass — 15/15                                                                                                                    |
| `turbo run test --force`      | Pass — 15/15, **1202 tests**                                                                                                    |
| `turbo run build --force`     | Pass — 8/8. `/admin/requests`, `/app/requests` and `/app/requests/new` prerender in `ar` and `en`; the `:id` routes are dynamic |
| `pnpm verify`                 | Not run — it needs real PostgreSQL and Redis                                                                                    |

The affected suites ran first: `phase9-rls`, `requests.e2e`, `attendance.e2e`, `attachments.e2e`, `request-query`, web `requests`, and i18n parity. The full set ran after them.

| Package        | Tests    | Phase 9 additions                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------------------ |
| `packages/db`  | 221      | **+21** — `test/phase9-rls.test.ts`                                                  |
| `apps/api`     | 671      | **+32** — `test/requests.e2e.test.ts` (24), `src/requests/request-query.test.ts` (8) |
| `apps/web`     | 197      | **+12** — `lib/requests.test.ts`                                                     |
| other packages | 113      | — (i18n parity covers the new keys in both languages)                                |
| **Total**      | **1202** | **+65** (1137 at the end of Phase 8)                                                 |

**Web test coverage note:** as in Phases 6–8, the web package has no component-rendering harness. The screens' rules are unit-tested in `lib/requests.ts`, and the layouts were checked in the browser pane. The covered rules are:

- inbox tabs and filters, the Pending default and URL round-trips;
- summary and age;
- form validation and body;
- decision bodies, including that reject requires a reason;
- the dashboard widget's query: pending, reviewable, five;
- paths.

The behaviour itself — history, submission, detail, cancel, pending count, the reviewable list behind the widget, scope — is proven end to end in the API suite.

**Final browser-pane check:** `/admin` in `ar` and `en` at 375px, on the production build, with no horizontal scroll. With no API, the dashboard's session gate shows its error state, so the KPI and widget themselves were not rendered with data.
