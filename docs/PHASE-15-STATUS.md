# Phase 15 — Notifications: status

**Roadmap reference:** DOCUMENT 25, Phase 15.
**Exit criterion:** every event in DOCUMENT 19 produces a notification for the correct recipients and no one else.

**Status: COMPLETE.** Committed as `Complete Phase 15: Notifications`.

The complete V1 notification system:

- every DOCUMENT 19 event, from its real source action, to exactly the right people;
- recipient resolution through role grants and scopes;
- post-commit delivery with a durable retry;
- deduplication, grouping and self-suppression;
- the notification centre (admin and employee), the bell and its unread count;
- company preferences;
- 12-month retention.

Phase 16 (public website) was **not** started. The final visual redesign was **not** applied: the screens use the current design system.

## Architecture

```
module transaction commits
  → module's event publisher (one port per module, *-events.ts)
  → NotificationSink (bound to every port's token by the global NotificationsModule)
  → NotificationPipeline.submit — one tenant transaction per company batch:
       1. claim each event's key in notification_events (already there → skip)
       2. NotificationRules.apply — the DOCUMENT 19 rule for the event
       3. RecipientResolver — role grants and scopes, in SQL
       4. drop the actor (self-suppression)
       5. drop types the company switched off (per channel)
       6. resolve "handled" on the other approvers' copies
       7. each channel dispatches — InAppChannel stores, grouping as rule 4 says
```

**Post-commit.** A notification is created only after the business transaction has committed:

- Every module publishes after its `withTenant` / `AuditDispatcher.withTenant` returns, so a rolled-back change never publishes.
- A failure inside the pipeline rolls back that batch only, claims included, and never reaches the module: its change stays committed. Proven both ways in the e2e.

**Channels.** `NotificationChannelDispatcher` is the seam:

- V1 has one dispatcher, `InAppChannel`. In-app delivery _is_ storage.
- Email or push is a new class added to `NOTIFICATION_CHANNELS`. The domain does not change.
- Company preferences are already per channel.

**Event boundaries added or extended:**

| Module                             | Boundary                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks                              | **new** `task-events.ts` — `task_assigned`, `task_updated`, and `task-jobs.ts` (hourly scan) for `task_overdue`, `task_deadline_approaching` |
| Attendance                         | **new** `attendance-events.ts` — the correction lifecycle and the nightly close's `missing_checkout`                                         |
| Employees                          | **new** `employee-events.ts` — `tasks_need_reassignment` on deactivation with open tasks                                                     |
| Goals                              | extended — `goal_assigned` on creation; `actorUserId` on milestones                                                                          |
| Requests                           | extended — `request_cancelled` (resolves the reviewers' notifications)                                                                       |
| Leave, Payroll, Inventory, Reports | unchanged events; the deferred sinks were removed and the ports bound to the pipeline                                                        |

No source logic is duplicated:

- Milestones come from the goal ledger, crossings from the stock movement, overdue from DOCUMENT 13 rule 1's own `overdueWhere`.
- The forgotten check-out comes from the nightly close itself.
- Payroll content carries no figures.

## Schema — migration `20261017000000_phase15_notifications`

Additive; nothing existing is rewritten.

- **`notifications`** — DOCUMENT 06 §3.34, both languages stored. Amendment columns:
  - `priority` and `audience` (`admin` / `employee`);
  - `event_id`;
  - `group_count` and `grouped_into_id` (summaries);
  - `handled_at`;
  - `updated_at`.
- **`notifications` checks and triggers:**
  - `type` is an enum; `related_type` is a known kind;
  - `related_id` may be null only on a summary;
  - non-empty content;
  - the recipient must be an **active, non-system user of the same company** (checked on insert);
  - the recipient, type, audience, channel and source kind never change.
- **`notifications` indexes:**
  - DOCUMENT 19's `(user_id, read_at, created_at)`;
  - `(user_id, type, created_at)` for grouping;
  - `(company_id, related_type, related_id)` for handled marking;
  - `(company_id, created_at)` for retention;
  - `(grouped_into_id)`.
- **`notification_events`** — unique `(company_id, event_key)`: idempotence and deduplication. Never updated.
- **`company_notification_settings`** — `(company_id, type, channel)`, enabled. No row means on. Never deleted.
- `audit_action` gains `settings.notification_changed` (catalogued in DOCUMENT 21, never in the type).
- RLS ENABLE + FORCE with tenant policies on all three tables.
- Least privilege for `ufuq_app`: DELETE only where retention needs it, no UPDATE on the event ledger.

## Events and recipients

Every recipient is an active user of the company. "Holders" means users whose role grants that permission:

- at **company** scope; or
- at **team** scope, when they are the subject's manager.

Nobody is told about their own action. Self-scope never makes someone a supervisor.

| Type                                               | Trigger (source)                                | Recipients                                                                            | Priority     |
| -------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- | ------------ |
| `leave_request_submitted`                          | leave submitted                                 | `leave.approve` holders                                                               | High         |
| `attendance_correction_submitted`                  | correction submitted                            | `attendance.approve_correction` holders                                               | High         |
| `request_submitted`                                | native request submitted                        | `request.review` holders                                                              | Medium       |
| `task_overdue`                                     | hourly scan, DOCUMENT 13 rule 1                 | `task.update` holders over the assignee                                               | Medium       |
| `low_stock` / `out_of_stock`                       | the movement that crossed the line              | company-scope `stock.view` holders                                                    | High         |
| `goal_milestone` (team)                            | goal ledger crossing                            | the goal's creator and the owner's manager, each only if their `goal.view` reaches it | Low          |
| `payroll_ready`                                    | payroll generation                              | company-scope `payroll.view` holders (not the generator)                              | High         |
| `employee_missing_checkout`                        | nightly close of an open record                 | `attendance.view` holders over the employee                                           | Low          |
| `tasks_need_reassignment`                          | deactivation with open tasks                    | `task.update` holders over the employee (not the deactivator)                         | Medium       |
| `task_assigned`                                    | task created / reassigned                       | the (new) assignee                                                                    | High         |
| `task_deadline_approaching`                        | hourly scan: open task due today (company zone) | the assignee                                                                          | Medium       |
| `task_updated`                                     | task edited / status set by someone else        | the assignee                                                                          | Low          |
| `leave_approved` / `leave_rejected`                | leave decided                                   | the employee                                                                          | High         |
| `correction_approved` / `correction_rejected`      | correction decided                              | the employee                                                                          | High         |
| `request_reviewed`                                 | native request decided                          | the employee                                                                          | Medium       |
| `salary_finalized`                                 | payroll finalized                               | every employee with a line (not the finalizer)                                        | High         |
| `goal_assigned`                                    | goal created                                    | the owner                                                                             | Medium       |
| `goal_milestone` (own)                             | goal ledger crossing                            | the owner                                                                             | Low          |
| `monthly_report_ready`                             | snapshot generated (scheduled or on demand)     | the employee (not when they generated it themselves)                                  | Low          |
| `missing_checkout`                                 | nightly close of an open record                 | the employee                                                                          | Medium       |
| `report_export_completed` / `report_export_failed` | background export outcome (DOCUMENT 18)         | the requester                                                                         | Low / Medium |

In practice, with V1's roles:

- **ADMIN** is a company-scope holder of everything above.
- **MANAGER** is told only about their own team, as the team constraint every module applies. A manager is never told about stock or payroll (OD-07).
- **EMPLOYEE** is told only about their own records.

**Multiple approvers (OD-18 decided A).** Every eligible approver is told. The first decision, or a cancellation, sets `handled_at` and marks read every approver's copy. The feed shows "Handled".

**Reassignment** is `task_assigned` for the new assignee. The previous assignee can no longer open the task, so they are not told (rule 1).

## Deduplication — event identity

| Moment                                                    | Key                            | Effect                                                                                    |
| --------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| Stock crossing                                            | the movement that crossed      | once per crossing; recovery then a new crossing is told again                             |
| Overdue / approaching task                                | task + deadline                | once per task, not per scan or per day; a moved deadline is a new moment                  |
| Goal milestone                                            | goal + threshold               | each of 25/50/75/100% once per goal, even after a drop and a rise                         |
| Missing check-out                                         | attendance record              | once; re-running the night tells nobody again                                             |
| Decisions, submissions, payroll, exports                  | the source record              | once                                                                                      |
| Repeatable actions (assign, edit, deactivate, regenerate) | a nonce stamped at publication | two actions are two moments, even in the same millisecond; a retry carries the same nonce |

## Grouping — DOCUMENT 19 rule 4

This is decided per recipient and type, under a transaction advisory lock:

1. An open summary (unread, active within the hour) absorbs new items. Its count, text and time update.
2. Otherwise, a summary is created when either:
   - the unread items of that type from the last hour plus the new ones are **more than three**; or
   - one operation concerns **several records** (a bulk operation).
     It absorbs the recent rows.
3. Otherwise each item is stored as itself.

A summary links to the list of its type (for example, five leave requests open `/admin/requests?category=leave`). Absorbed rows stay stored, for handled marking and retention, but leave the feed and the count. Reading a summary reads its rows. After an hour, or once the summary is read, new items start fresh.

## Deep links (web)

The audience picks the side, `/admin` or `/app`:

| Source                               | Admin side                                                    | Employee side             |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------- |
| request (leave, correction, request) | `/admin/requests/:id`                                         | `/app/requests/:id`       |
| task                                 | `/admin/tasks/:id`                                            | `/app/tasks/:id`          |
| goal                                 | `/admin/goals/:id`                                            | `/app/goals/:id`          |
| product                              | `/admin/inventory/:id`                                        | —                         |
| payroll period                       | `/admin/payroll/:id`                                          | `/app/salary/:id`         |
| attendance record                    | `/admin/attendance?date=…`                                    | `/app/attendance/history` |
| employee (reassignment)              | `/admin/tasks?assignee=:id`                                   | —                         |
| monthly report                       | —                                                             | `/app/reports/:month`     |
| report export                        | `/admin/reports/:key`                                         | —                         |
| summary                              | the list of its type (requests by category, overdue tasks, …) | the list                  |

Tapping marks the item read, then opens it. The API reports whether each source still exists, with one query per kind of source on the page. A deleted source renders **"No longer available"** (Arabic: "لم يعد متاحًا") and goes nowhere.

## Content and languages

- Templates are in the i18n catalogue (`notifications.content.*` / `notifications.summary.*`, RULE 24).
- Both languages are rendered at write time and stored, so a language change renders history in the new language. Proven in the API (both variants) and in the browser.
- Dates and months are written the way each language writes them ("06 May 2026" / "06 مايو 2026", "March 2026" / "مارس 2026"); an ISO date would break at its hyphens in a right-to-left line.
- **No figures** (rule 7). Payroll notifications say "Your salary for March 2026 has been finalized." / "تم اعتماد راتبك". The e2e asserts that no amount, currency or digit run (beyond the year) appears in any payroll notification.

## Retry and failure

- A failed batch is queued on BullMQ (`notifications`): 8 attempts, exponential backoff from 5 s, the batch's hash as the job id.
- The retry is idempotent on the event keys.
- If even the enqueue fails, or the retries run out, the batch is logged in full at error level as `NOTIFICATION_FALLBACK`. Never silent.
- The retry worker runs only where background jobs run (the audit dispatcher's pattern).

## Retention

- A daily job (`notifications-retention`) deletes, company by company in its own tenant scope, the notifications and processed events created more than **12 months** ago.
- Deletion is in bounded batches. The job is idempotent and retry-safe, and one company's failure never stops the others.
- The overdue scan only considers deadlines from the last 30 days, so a purged event cannot be re-announced.

## Company preferences — DOCUMENT 19 rule 10

`/admin/settings/notifications` (B25): one switch per type, for the whole company.

- Reading needs `settings.view`; saving needs `settings.update`. Every change is audited `settings.notification_changed` with each switch's old and new value.
- Only `in_app` is accepted in V1. Email and push are named as not available.
- Per-user preferences are FUTURE.

## Deactivated users

- The recipient must be active when the notification is created. The resolver and the database both check it.
- A notification stored before a deactivation is kept.
- Deactivation revokes the user's sessions, so the centre is unreachable (401). Nothing new is stored for an inactive recipient.
- No external channel exists in V1. A future dispatcher must skip inactive recipients, as DOCUMENT 19 requires.

## API — DOCUMENT 08 §4.13 (amended)

| Method | Path                          | Who                                                              |
| ------ | ----------------------------- | ---------------------------------------------------------------- |
| GET    | `/notifications`              | authenticated — own feed; `page`, `per_page` ≤ 50, `unread=true` |
| GET    | `/notifications/unread-count` | authenticated — own count                                        |
| POST   | `/notifications/{id}/read`    | authenticated — own only; another user's id is 404               |
| POST   | `/notifications/read-all`     | authenticated — own only                                         |
| GET    | `/settings/notifications`     | `settings.view`                                                  |
| PATCH  | `/settings/notifications`     | `settings.update`                                                |

No route takes a user id; `?user_id=` is refused (422).

## Web

- **Header strip** (`app-topbar.tsx`, rendered by the new `/admin` and `/app` layouts):
  - the way home, the language switch and the **bell**, with an unread badge capped at 99+;
  - it persists across navigations. It is not the product navigation, which comes with the redesign.
- **Unread count:** one shared poller (`UnreadCounter`) fetches it:
  - when the shell loads;
  - on each navigation;
  - every 60 seconds while a bell is mounted;
  - after a read.
    Concurrent calls join one request. It never fetches per render: measured as one request per page load in the browser.
- **Notification centre** (`/app/notifications`, C14, and `/admin/notifications`), the caller's own feed:
  - grouped by day in the company's timezone; unread emphasised by weight, a dot and a screen-reader label;
  - summary count, "Handled", "No longer available", "High priority" (only High is badged — not noisy);
  - mark one read, mark all read, All / Unread filter, load more, Refresh;
  - pull to refresh on touch;
  - loading, empty, error-with-retry and ready states.
- **Settings:** `/admin/settings/notifications`.

## Tests

| Event / behaviour                                                               | Where it is proven (`apps/api/test/notifications.e2e.test.ts` unless stated)                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leave_request_submitted`                                                       | real submission → exactly ADMIN_A, ADMIN2, MANAGER; Arabic and English text; source link; three rows in the whole database                                                                                                          |
| `leave_approved` + multiple approvers                                           | manager approves → employee told; all three approvers' copies handled and read                                                                                                                                                      |
| `leave_rejected`                                                                | → the employee only; the deciding admin not told                                                                                                                                                                                    |
| self-suppression                                                                | an admin's own leave → the other admin only; a self-assigned task → nobody; the manager's own goal progress → manager not told; an employee generating their own report → nobody                                                    |
| cancellation resolves                                                           | leave and request cancellations tell nobody and mark the reviewers' copies handled                                                                                                                                                  |
| `attendance_correction_submitted`, `correction_approved`, `correction_rejected` | real corrections → approvers, then the employee                                                                                                                                                                                     |
| `request_submitted`, `request_reviewed`                                         | team request → admins + its manager; another team → MANAGER2, never MANAGER; approved and rejected wording                                                                                                                          |
| `task_assigned`, reassignment                                                   | → the assignee; reassignment → the new assignee only                                                                                                                                                                                |
| `task_updated`                                                                  | edit / status by someone else → assignee; the assignee's own change → nobody                                                                                                                                                        |
| `task_deadline_approaching`                                                     | scan: open task due today → assignee once; completed and tomorrow's not; Cairo midnight, not UTC                                                                                                                                    |
| `task_overdue`                                                                  | scan → supervisors once; repeat scans over 2 days → no duplicate; moved deadline → a new moment; completed → never                                                                                                                  |
| bulk summary                                                                    | one scan with two overdue tasks → one summary per supervisor                                                                                                                                                                        |
| `goal_assigned`, `goal_milestone`                                               | owner; owner + creator + manager (with each one's wording); each threshold once, even after a drop and a rise                                                                                                                       |
| `low_stock`, `out_of_stock`                                                     | crossing → company-scope stock holders only; no repeat while low; zero → out; recovery then new crossing → told again                                                                                                               |
| `payroll_ready`, `salary_finalized`                                             | real generation and finalization → ADMIN2; every employee with a line; no figures                                                                                                                                                   |
| `missing_checkout`, `employee_missing_checkout`                                 | the nightly close → each employee; one summary per supervisor; re-run → nothing new                                                                                                                                                 |
| `tasks_need_reassignment` + inactive user                                       | deactivation → admin + manager, not the deactivator; history kept; 401; nothing new stored                                                                                                                                          |
| `monthly_report_ready`                                                          | admin generation → employee; self-generation → nobody                                                                                                                                                                               |
| `report_export_completed` / `_failed`                                           | background export → the requester; storage failure → the failure notification                                                                                                                                                       |
| tenant isolation                                                                | company B's leave → B's admin only; A sees nothing and gets 404 by id                                                                                                                                                               |
| feed, paging, bounds                                                            | own only, newest first, 3 pages of 10, 51 → 422, `user_id` → 422                                                                                                                                                                    |
| unavailable source                                                              | deleted task → `available: false`                                                                                                                                                                                                   |
| read / read-all / count                                                         | own only; another's id 404 and stays unread; idempotent; unread filter                                                                                                                                                              |
| locale                                                                          | both stored variants identical under `ar` and `en`                                                                                                                                                                                  |
| grouping                                                                        | 3 separate → 4th collapses → 5 in one summary for each approver → read reads rows → after an hour a new item is separate                                                                                                            |
| rollback                                                                        | forced failure in the task insert → 500, no notification, no event recorded                                                                                                                                                         |
| retry                                                                           | forced failure in the notification insert → task committed, batch queued; retry delivers once, second retry nothing                                                                                                                 |
| retention                                                                       | cutoff − 1 ms deleted, cutoff + 1 ms kept, other company untouched until its own run, second run deletes nothing                                                                                                                    |
| company preferences                                                             | admin turns a type off (audited) → no notification; manager 403; email refused; back on → delivered                                                                                                                                 |
| `src/notifications/notification-catalogue.test.ts`                              | catalogue = DB enum; DOCUMENT 19 priorities; every type and summary has Arabic and English content with every placeholder filled; event identity rules                                                                              |
| `packages/db/test/phase15-rls.test.ts`                                          | RLS on all three tables; active same-company recipient; unknown type refused; source required except on a summary; immutable identity; unique event key; ledger never updated; retention deletes; settings never deleted; the index |
| `apps/web/src/lib/notifications.test.ts`                                        | every deep link, summaries, unavailable, 99+, day grouping in the company zone, one poller (no per-render fetch, stops when unused)                                                                                                 |
| `apps/web/src/lib/i18n-keys.test.ts`                                            | every literal message key the web asks for exists in both languages                                                                                                                                                                 |

## Browser verification

This ran against a temporary local stack: the real API over PGlite, seeded through its own endpoints (leave, requests, tasks, goal progress, stock movements), and the **production build** of the web app. The harness was deleted before commit.

- **Bell and badge:** the admin's bell showed 3 — the pending leave, the 4-request summary and low stock. The leave already approved was handled and read.
- **Feed:** grouped "Today" / older dates; unread emphasised; summary "New requests: 4" with "4 items"; "Handled" on the decided leave.
- **Deep links:**
  - tapping the summary marked it read and opened `/en/admin/requests` (badge 3 → 2);
  - "Leave approved" opened the employee's request;
  - the task and goal links opened their screens.
- **Unavailable source:** the deleted task showed "No longer available"; tapping marked it read and stayed.
- **Mark read and mark all:** "Mark as read" → badge 1; "Mark all as read" → no badge, button disabled; the Unread filter showed the empty state.
- **Error and retry:** with the feed request failing, the error state with Retry; Retry recovered.
- **Manager:** team requests and leave, team goal milestones in the manager wording, no stock or payroll.
- **Language switch:** the real switch re-rendered the same history in English (`lang=en dir=ltr`) from the stored variants; Arabic RTL renders the Arabic variants.
- **Settings:** turning "Task overdue" off and saving showed the success notice, and the API reflects it.
- **Pull to refresh:** "Release to refresh" during the pull, then one feed request.
- **Polling:** one unread-count request and one feed request per page load.
- **Overflow sweep:** the admin and employee centres and dashboards (which now carry the header strip), in **Arabic and English**, at **375, 800 and 1280 px**. Twenty combinations, **no page-level horizontal overflow**.

## Bugs found and fixed

1. **Same-millisecond actions collapsed into one** (e2e, frozen clock). Repeatable actions were keyed by their commit time, so two edits in one millisecond were treated as one. Fix: the sink stamps a nonce on every publication; retries keep it.
2. **An English sentence starting with an Arabic name rendered right-to-left** (browser). `dir="auto"` was on the item text. Fix: the text takes the page's direction, because it is always the page's language.
3. **ISO dates broke across lines in Arabic** (browser). Fix: dates and months are written per language.
4. **The leave request screen crashed** (browser, while following a leave notification). The cause was a **pre-existing Phase 10 defect**: five message keys (`leave.col_year`, `col_total`, `col_used`, `col_pending`, `col_remaining`) were never added, and a missing key throws. Fix: the keys, plus a web test that fails if any literal key is missing in either language.
5. **The centre fetched the unread count twice on load** (browser). Fix: only an explicit refresh or a read fetches it again.
6. **The settings rows wrapped inconsistently** (browser). Fix: the meta line sits under every switch.

## Accepted limitations

- **Availability** of a source means "it still exists (not deleted)". Whether the reader may still open it — a team that changed, a reassigned task — is enforced by the destination screen's own authorization.
- **Grouping** counts unread notifications only: items the user has already read are not pulled back into a new unread summary.
- **The header strip** is the minimum every screen needs for the bell. The product navigation arrives with the redesign.
- **Payroll adjustments and the "more information" response** in the Requests Centre (DOCUMENT 05 flows) are not DOCUMENT 19 types and notify nobody in V1.
- **The web audit-log viewer's catalogue** does not list `settings.notification_changed`; it is stored and filterable through the API (as for Phase 12's actions).

## FUTURE — not unfinished V1

DOCUMENT 19 "Future extensions", explicitly out of V1:

- email notifications and email digests;
- web and mobile push;
- SMS / WhatsApp for critical events;
- quiet hours;
- per-user notification preferences;
- direct actions inside a notification (approve or reject from it);
- escalation when a high-priority notification goes unread.

## Verification results

The complete gate was run from scratch after the last code change, every turbo task forced (0 cached).

| Check                         | Result                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `prettier --check .`          | Pass                                                                                                  |
| `turbo run lint --force`      | Pass — 9/9 tasks, 0 errors (the 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`) |
| `turbo run typecheck --force` | Pass — 15/15 tasks                                                                                    |
| `turbo run test --force`      | Pass — 15/15 tasks, **1,785 tests**, 0 failed                                                         |
| `turbo run build --force`     | Pass — 15/15 tasks                                                                                    |

| Package        | Test files | Tests     | Phase 15 additions                                                   |
| -------------- | ---------- | --------- | -------------------------------------------------------------------- |
| `@ufuq/api`    | 38         | 1,059     | 43: `notifications.e2e` 34, `notification-catalogue` 9               |
| `@ufuq/db`     | 17         | 335       | 12: `phase15-rls`                                                    |
| `@ufuq/web`    | 21         | 278       | 8: `lib/notifications` 7, `lib/i18n-keys` 1 (`settings-nav` updated) |
| `@ufuq/auth`   | 5          | 44        | —                                                                    |
| `@ufuq/money`  | 1          | 25        | —                                                                    |
| `@ufuq/config` | 1          | 20        | —                                                                    |
| `@ufuq/i18n`   | 1          | 20        | —                                                                    |
| `@ufuq/mobile` | 1          | 4         | —                                                                    |
| **Total**      | **85**     | **1,785** | **63** (Phase 12 ended at 1,722)                                     |

Every existing suite also passes with the real pipeline behind its module's events (tasks, goals, leave, requests, attendance, employees, payroll, inventory, warehouse, reports).
