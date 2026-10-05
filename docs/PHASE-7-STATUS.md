# Phase 7 — Tasks & checklists: status

**Roadmap reference:** DOCUMENT 25, Phase 7
**Exit criterion:** _progress calculation is correct in every checklist
scenario, and invalid status transitions are rejected server-side._

**Status: COMPLETE.** Every documented Phase 7 requirement passes, including
task attachments, built on 2026-10-05 as an approved addendum together with the
generic attachment store they need (see "Attachment addendum" below). The
legitimate deferrals are goal linking (Phase 8) and notifications (Phase 15).

Both clauses are proved over HTTP against the real application
(`apps/api/test/tasks.e2e.test.ts`). The connection runs as `ufuq_app`, so
row-level security is enforced throughout. The arithmetic and the matrix are
also pinned without a database (`apps/api/src/tasks/task-rules.test.ts`).

| Clause                                           | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **progress correct in every checklist scenario** | One task is walked through tick → 25, 50, 75; untick → 50; re-tick of a ticked item (idempotent: 200, no change, no audit); add an open item → 60 (3 of 5); delete the open item → 75; delete a ticked item → 66.67; tick → 100 (status unchanged); delete every item → 50.00 (no division by zero; OD-10 rule). Also: DOCUMENT 13's own 6 of 8 → 75.00; 1 of 3 → 33.33 and 2 of 3 → 66.67, read back from the column; a checklist added after completion → 0.00 while the task stays completed; no checklist → 0 / 50 / 50 on hold / 100 / 50 reopened; on hold and cancelled keep their value; the first progress note starts the task and records 50.00. The unit suite checks every count of a 1- to 12-item list against an independent BigInt oracle. |
| **invalid transitions rejected server-side**     | All **25** (from, to) pairs are attempted, each on a fresh task driven to `from` through allowed moves only, with a reason and the open-items confirmation always supplied, so the matrix alone decides. Exactly the nine DOCUMENT 13 rule 4 transitions return 200. The other 16, including every same-status "no-op", return **422 `INVALID_STATUS_TRANSITION`**. Each 422 names the allowed transitions in `fields.allowed_transitions` and leaves the task's status and progress untouched. Also refused: `overdue` as a status (422), a status change through `PATCH` (422), cancel and reopen without a reason (422), and completing a cancelled task (422, empty allowed list).                                                                      |

---

## Final spec completion — 2026-10-03

Three documented integration gaps were closed or escalated. No Phase 8
business logic was added, and no existing screen was redesigned.

### 1. Employee profile — Tasks tab and "Assign task" (DOCUMENT 04 B4) — built

- **Tasks tab** (`components/tasks/employee-tasks.tsx`):
  - It replaces the Phase 5 empty state with "a filterable task list scoped
    to this employee".
  - It is the existing `GET /tasks?assignee_employee_id=…`, rendered by the
    existing `TaskTable`. The table was extracted from the task list into
    one component used by all three surfaces, so no task logic is
    duplicated.
  - Filters: status, priority and overdue-only, plus the page. They live in
    the URL under `task_*` keys, so they never collide with the profile's own
    `notice` and `history_page`.
  - States: loading; empty (with "Assign task" when permitted); filtered
    empty (with "Clear filters"); error with retry.
  - **Scope stays server-side.** The assignee is a filter AND-ed with the
    caller's `task.view` scope. The e2e suite proves that a manager asking
    for an employee outside their team gets an empty list.
- **"Assign task" quick action:**
  - It sits in the profile header and is rendered only when the caller holds
    `task.create` and the employee is active, since an inactive assignee is
    refused (DOCUMENT 13).
  - It links to `/admin/tasks/new?assignee=<id>`. The create form preselects
    that employee and their department once its options load.
  - An id outside the caller's assignable list is simply not applied. The
    API refuses it anyway, whatever the scope (`team` for a manager,
    `company` for an admin).

### 2. Tasks needing reassignment (DOCUMENT 13 edge case) — built

- **API:** `GET /tasks` gains one filter, `needs_reassignment=true`: open
  tasks (`not_started`, `in_progress`, `on_hold`) whose assignee is not
  `active` or has been removed. It is AND-ed with the caller's scope like
  every other filter, and any other value is 422.
  - This is the only new query surface. A per-employee fan-out from the
    browser would have needed one request per inactive employee, so the
    scope is applied once on the server instead.
- **Dashboard:** `/{locale}/admin` (DOCUMENT 04 B1, DOCUMENT 03 §2 item 1) now
  exists with **one** widget, `tasks-needing-reassignment.tsx`.
  - The page is gated on `report.company` / `report.team`, as B1 specifies.
    The widget's data is scoped by `task.view`, so a manager sees their team.
  - The widget lists every such task with the shared `TaskTable`. Each row
    links to the task, where "Edit" reassigns it.
  - The widget loads, fails and retries independently. Its empty state reads
    "Nothing to reassign".
  - The other ten B1 widgets are not rendered, not even as placeholders
    (RULE 26). They belong to the modules that own their data.
- **Proved** (`tasks.e2e`, +5):

  - the open and on-hold tasks of a deactivated employee are listed, and
    their completed task is not;
  - a task leaves the list once reassigned to an active employee;
  - a manager sees their team's tasks;
  - an employee and another company see nothing;
  - `needs_reassignment=false` is 422;
  - the per-employee list is narrowed by scope.

  `task-query.test` +1 pins the query shape.

### 3. Task attachments — escalated, then approved and built

On 2026-10-03 no attachment subsystem existed, so this was raised as
`[DECISION REQUIRED]` with three options. **Option A was approved on
2026-10-05**: build the generic DOCUMENT 08 §4.14 attachment store now, as a
Phase 7 addendum, and wire tasks to it. See "Attachment addendum" below.

### Verification — 2026-10-03

| Command                       | Result                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `pnpm format:check`           | Pass                                                            |
| `turbo run lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings) |
| `turbo run typecheck --force` | Pass — 15/15                                                    |
| `turbo run test --force`      | Pass — 15/15, **874 tests** (+10), 0 cached                     |
| `turbo run build --force`     | Pass — 8/8; `/admin` prerenders in `ar` and `en`                |

The affected suites ran first: `tasks.e2e` (83), `task-query` (7), and web
`tasks` (20) and i18n parity. The full set above ran after them. The new
dashboard was checked in the browser pane in `ar` (RTL) and `en` (LTR) at
375px, with no horizontal scroll. As before, no API runs here, so the pane
showed the error state.

Totals: `packages/db` 139, `apps/api` **476** (+6), `apps/web` **151** (+4),
the rest unchanged. That is **874** in all.

## Attachment addendum — 2026-10-05

Approved as **Option A**. The design comes from the documents rather than a
new architecture decision: AD-02 (private S3-compatible storage), DOCUMENT 06
§3.36 (the table), DOCUMENT 08 §4.14 and §6 (the API and its rate limit),
DOCUMENT 20 §§3, 4 and 7 (upload and isolation rules), and DOCUMENT 21 (the
audit events). Only the generic store and its task integration were built.
Employee photos, attendance corrections, leave and company logos were **not**
wired. Each can add itself later by registering a policy (see below).

### `packages/db` — migration `20261005000000_phase7_attachments`

- `attachments` is DOCUMENT 06 §3.36 column for column, with a Prisma model
  `Attachment`.
- `audit_action` gains `attachment.uploaded`, `attachment.deleted` and
  `attachment.accessed`.
- **CHECK constraints**, so the rules hold however a row is written:
  - `mime_type` must be one of DOCUMENT 20 §7's six types;
  - `stored_path` must begin with the row's own `company_id` (DOCUMENT 20 §3
    "company-namespaced paths"), and is unique;
  - `size_bytes > 0`;
  - `checksum` is a lowercase SHA-256;
  - the original name is non-blank;
  - `related_type` is a closed list, `task` only for now.
- **Same-company trigger.** `related_id` is polymorphic and has no foreign key,
  so this trigger is what refuses a link to another company's task, or an
  uploader from another company.
- **Row-level security**, FORCE'd, with the tenant policy.
- **No DELETE** for `ufuq_app`. Removal is a soft delete (DOCUMENT 08 §4.14).
- **Proved** in `packages/db/test/phase7-attachments-rls.test.ts` (26 tests),
  as `ufuq_app` with no WHERE clauses:
  - isolation in both directions;
  - nothing visible with no tenant bound;
  - cross-tenant writes and moves refused;
  - the cross-company `related_id` and uploader refused;
  - each allowed type accepted and five disallowed ones refused (including
    SVG, HTML and a macro-enabled workbook);
  - the namespacing CHECK and key uniqueness;
  - DELETE refused, soft delete allowed;
  - the three audit values present.

### `apps/api` — `src/attachments/`

| Method | Endpoint            | Authorization                                                         |
| ------ | ------------------- | --------------------------------------------------------------------- |
| POST   | `/attachments`      | multipart `file` + `related_type` + `related_id`; the record's policy |
| GET    | `/attachments/{id}` | authorization-checked stream; never a public URL                      |
| DELETE | `/attachments/{id}` | soft delete, audited                                                  |

- **Authorization lives with the record.** Each `related_type` registers an
  `AttachmentPolicy` that answers in its record's own terms: may view, may
  upload, may delete, and whether its files are sensitive.
  - There is no attachment permission. A file is exactly as reachable as its
    record, so `related_type`/`related_id` cannot be used to bypass the
    record's scope.
  - The record not visible is **404**. Visible but not permitted is **403**.
  - `TaskAttachmentPolicy` is built only on `taskScopeWhere`:
    - **view:** the task is in the caller's `task.view` scope;
    - **upload:** the caller is the task's assignee, or has `task.update`
      scope over it (Admin `company`, Manager `team`);
    - **delete (V1):** `task.update` scope only, so an assignee cannot
      remove a file, not even their own;
    - a soft-deleted task's files are unreachable.
- **Storage (AD-02).** An `ObjectStorage` port, implemented by
  `S3ObjectStorage` over `@aws-sdk/client-s3` (MinIO locally) and configured
  only through the existing `STORAGE_*` variables.
  - The port has no URL method at all: no presigned or public link exists for
    any code to hand out.
  - Objects are written with no ACL, so they inherit the bucket's private
    default. Each carries S3's own SHA-256 integrity check.
- **Keys.** `{company_id}/{256 random bits, hex}`. Nothing the client sent
  takes part in the key, and it is never returned in any response.
- **Checks on upload (DOCUMENT 20 §7), in order:**
  1. Rate limit: 30 uploads per hour per user (DOCUMENT 08 §6), counted per
     attempt, answered with 429 and `Retry-After`.
  2. A file must be present and non-empty.
  3. Size: at most `STORAGE_MAX_UPLOAD_BYTES`, default 10 MB (10,485,760
     bytes). Multer refuses larger files before the handler runs and the
     service checks again; both answer **422 `file: too_large`**.
  4. Type: the declared MIME must be allowed **and** equal the type the magic
     bytes identify, otherwise **422 `file: unsupported_type`**.
     - DOCX and XLSX are recognised by their required OOXML parts, not by the
       ZIP signature.
     - A container holding `vbaProject.bin` is refused, which catches a
       macro-enabled file renamed to `.docx` or `.xlsx`.
  5. Authorization through the policy.
- **Original name** is sanitised and kept as metadata only. Directory parts,
  control characters, null bytes, bidi overrides (the "gnp.exe" disguise),
  reserved characters and leading dots are removed. It is capped at 255
  characters with the extension kept, and Arabic is preserved (multer reads
  file names as UTF-8).
- **Transactions.** The row, the audit record and the object write happen in
  one transaction, so a failed object write leaves no row and no audit.
  Multer keeps uploads in memory only; nothing touches the API host's disk.
- **Download headers:** `Content-Disposition: attachment` (with the RFC 5987
  UTF-8 name, never `inline`), `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cache-Control: private, no-store`, and `Repr-Digest` carrying the
  SHA-256.
- **Audit (DOCUMENT 21).**
  - `attachment.uploaded` and `attachment.deleted` are recorded with
    metadata only: name, type, size, checksum and the related record. Never
    the contents, never the storage key.
  - `attachment.accessed` is recorded only for a policy marked sensitive.
    Task files are not sensitive, so downloads are not audited.
- **Task detail.** `GET /tasks/{id}` now carries `attachments: { items,
can_upload, can_delete }`. The two flags are the policy's own answers, the
  `allowed_transitions` pattern. No undocumented list endpoint was added.
- **Configuration.** `STORAGE_MAX_UPLOAD_BYTES` was added to `@ufuq/config`
  (must be a whole number of at least 1) and to `.env.example`.
- **Proved** in `apps/api/test/attachments.e2e.test.ts` (42 tests), against
  the real app as `ufuq_app` with an in-memory object store:
  - **Storage:** the key's shape and that the bytes stored are the bytes
    sent; no key or URL in any response.
  - **Types:** all six types accepted; eight disguises refused with nothing
    written to storage (an executable labelled as a PDF, PNG and PDF swapped,
    HTML, SVG with script, a macro workbook, a plain ZIP labelled as DOCX, a
    shell script).
  - **Size and names:** exactly 10 MB accepted and one byte more refused; a
    missing or empty file refused; traversal and reserved-character names
    sanitised; Arabic names kept.
  - **Input validation:** `company_id` in the form, an unregistered related
    type and a malformed id are all 422.
  - **Rate limit:** the 31st upload in the window is 429 with `Retry-After`,
    and another user is unaffected.
  - **Upload scope:** the assignee, a manager within their team and an admin
    can upload. Outside the scope, on another company's task, or on a deleted
    task is 404.
  - **Download:** exact bytes with every header above. 404 outside the scope,
    across companies and for an unknown id; 401 with no session.
  - **Delete:** 403 for the assignee; 404 outside the scope and across
    companies. A manager's or admin's delete is a soft delete: the object is
    kept, and the file then answers 404.
  - **Audit:** metadata only; no `accessed` record for task files; readable
    through the audit log.
  - **Task detail:** live files newest first, deleted ones left out; the
    `can_upload`/`can_delete` flags correct for each role.
- **Unit tests:** `file-checks.test.ts` (24: magic bytes, sanitising,
  `Content-Disposition`) and `s3-object-storage.test.ts` (3: the exact put
  and get commands, and no ACL).

### `apps/web`

- **Task detail** (`/admin/tasks/:id` and `/app/tasks/:id`) gains an
  **Attachments** card (`components/tasks/task-attachments.tsx`):
  - The list shows the name (`dir="auto"`), type, size in the reader's
    digits and units, who added it and when.
  - Download is a link to `GET /attachments/{id}`.
  - Upload uses the native file picker, filtered to the six types, which on a
    phone also offers the camera (DOCUMENT 13 "Mobile behaviour").
  - Remove opens a confirmation dialog.
  - Upload and remove are rendered from the server's `can_upload` and
    `can_delete`.
  - States: empty state; uploading; a success notice; and a specific sentence
    for each refusal (too large, unsupported type, rate limited, not found,
    forbidden).
- `uploadForm` in the API client sends multipart with the CSRF header and
  lets the browser write the boundary.
- `lib/attachments.ts` holds the pure helpers, with 13 tests.
- The audit log's action and record-type lists gain the three
  `attachment.*` actions and the `attachment` record type, each with a
  verb-first Arabic sentence.
- All strings are in both catalogues, and the parity test covers them. The
  styles use logical properties and existing tokens only.
- Not checked in the browser pane: as in every earlier phase, no API or
  database runs here, so the populated card could not be seen with data.

### Housekeeping

- Dependency added: `@aws-sdk/client-s3` `3.1146.0`, pinned exactly, in
  `apps/api` (`pnpm-lock.yaml` updated).
- Every e2e test environment gains `maxUploadBytes`, because the `Env` type
  now requires it. No assertion in those suites changed.

### Verification — 2026-10-05

| Command                       | Result                                                          |
| ----------------------------- | --------------------------------------------------------------- |
| `pnpm format:check`           | Pass                                                            |
| `turbo run lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings) |
| `turbo run typecheck --force` | Pass — 15/15                                                    |
| `turbo run test --force`      | Pass — 15/15, **987 tests** (+113), 0 cached                    |
| `turbo run build --force`     | Pass — 8/8                                                      |

The affected suites ran first: `attachments.e2e` (42), `tasks.e2e` (83),
`audit-logs.e2e`, `file-checks`, `s3-object-storage`,
`phase7-attachments-rls` (26), `phase7-rls`, `@ufuq/config`, and web
`attachments`, `audit` and `tasks`. The full set above ran after them.

| Package           | Tests   | Change since 2026-10-03                                                                    |
| ----------------- | ------- | ------------------------------------------------------------------------------------------ |
| `packages/auth`   | 44      | —                                                                                          |
| `packages/config` | 20      | **+5** — `STORAGE_MAX_UPLOAD_BYTES`                                                        |
| `packages/i18n`   | 20      | — (parity now covers the attachment keys)                                                  |
| `packages/money`  | 25      | —                                                                                          |
| `packages/db`     | 165     | **+26** — `test/phase7-attachments-rls.test.ts`                                            |
| `apps/api`        | 545     | **+69** — `test/attachments.e2e.test.ts` (42), `file-checks` (24), `s3-object-storage` (3) |
| `apps/web`        | 164     | **+13** — `lib/attachments.test.ts`                                                        |
| `apps/mobile`     | 4       | —                                                                                          |
| **Total**         | **987** | **+113** (874 on 2026-10-03; 712 at the end of Phase 6)                                    |

---

## Approved decisions

Two documents disagreed. Both conflicts were raised before implementation
(DOCUMENT 27 RULE 35) and decided:

0. **Task attachments: Option A (2026-10-05).** Build the generic attachment
   store as a Phase 7 addendum and wire tasks to it. For V1, deleting a task
   attachment is limited to Admin/Manager with `task.update` scope.
1. **OD-10, progress without a checklist: status-derived, 0 / 50 / 100.**
   DOCUMENT 13 rule 3 says "0% / 100% from status"; OD-10 option A says
   "0% / 50% / 100%". Approved: `not_started` 0, `in_progress` 50,
   `completed` 100. **On hold and cancelled keep the progress the task already
   had**, because neither document covers them and pausing or cancelling work
   does not change how much of it was done. No per-company setting exists:
   OD-10 recommends A for V1, and option C (configurable) was not chosen.
2. **A task outside the caller's `task.view` scope is 404, not 403.**
   DOCUMENT 13 "Error states" says 404; DOCUMENT 09 §4, which Phases 5–6
   followed, says 403 for in-tenant, out-of-scope rows. Approved: DOCUMENT 13
   wins for tasks, so an employee is never told that a colleague's task
   exists. A task that is visible but outside the scope of the action's own
   permission is still 403. In V1 the view scope and the action scopes are
   equal for every role, so this case cannot occur today.

---

## Verification results

| Command                       | Result                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | Pass — "All matched files use Prettier code style"                                                                           |
| `turbo run lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`)                              |
| `turbo run typecheck --force` | Pass — 15/15                                                                                                                 |
| `turbo run test --force`      | Pass — 15/15, **864 tests** (+152), 0 cached                                                                                 |
| `turbo run build --force`     | Pass — 8/8; `/admin/tasks`, `/admin/tasks/new` and `/app/tasks` prerender in `ar` and `en`; the two `:id` routes are dynamic |
| `pnpm verify`                 | Not run — it needs real PostgreSQL and Redis, and Docker is not available in this environment                                |

The affected suites ran first: `phase7-rls` (30), `task-rules` (22),
`task-query` (6), `tasks.e2e` (78), `audit-logs.e2e`, web `tasks` (16) and
`audit`, and i18n catalogue parity. The full set above ran after them.

### Test totals

| Package           | Tests   | Phase 7 additions                                                                                                 |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/auth`   | 44      | —                                                                                                                 |
| `packages/config` | 15      | —                                                                                                                 |
| `packages/i18n`   | 20      | — (catalogue parity now covers the task, error and audit keys)                                                    |
| `packages/money`  | 25      | —                                                                                                                 |
| `packages/db`     | 139     | **+30** — `test/phase7-rls.test.ts`                                                                               |
| `apps/api`        | 470     | **+106** — `test/tasks.e2e.test.ts` (78), `src/tasks/task-rules.test.ts` (22), `src/tasks/task-query.test.ts` (6) |
| `apps/web`        | 147     | **+16** — `lib/tasks.test.ts`                                                                                     |
| `apps/mobile`     | 4       | —                                                                                                                 |
| **Total**         | **864** | **+152** (712 at the end of Phase 6)                                                                              |

---

## What is complete

### `packages/db` — migration `20261003000000_phase7_tasks`

`tasks`, `task_checklist_items` and `task_progress_updates`, as DOCUMENT 06
§3.15–3.17. The DOCUMENT 27 RULE 31 migration implications are at the top of
the file. It adds two types (`task_status`, `task_priority`) and the ten
DOCUMENT 21 task actions to `audit_action`. It is a new migration, and no
earlier one was edited.

- **Indexes** are DOCUMENT 13's four: `(company_id, status)`,
  `(assignee_employee_id, status)`, `(company_id, deadline)` and
  `(task_id, position)`, plus `(task_id, created_at)` for the progress
  history.
- **Foreign keys:** `CASCADE` from a task to its checklist items and progress
  updates (DOCUMENT 06 §5, DOCUMENT 13). `RESTRICT` on the assignee,
  department and creator.
- **CHECK constraints** encode the validation that must hold however a row is
  written: title of at least 3 non-blank characters; `deadline ≥ start_date`;
  progress between 0 and 100; `completed_at` set exactly when the status is
  `completed`; a non-blank `cancelled_reason` whenever the status is
  `cancelled`; non-blank checklist titles; `completed_at` set exactly when an
  item is ticked; notes that are non-blank and at most 2000 characters.
- **Same-company triggers** on all three tables (DOCUMENT 07 §9 invariant 7).
  The child tables check against their parent task's company.
- **Least privilege:**
  - `tasks` has no DELETE (soft delete only, DOCUMENT 06 §6).
  - `task_progress_updates` has neither UPDATE nor DELETE (append-only,
    DOCUMENT 13 rule 9).
  - `task_checklist_items` keeps full DML: an item is removed outright
    (FLOW 11), and DOCUMENT 06 gives it no `deleted_at`.
  - Each restriction is an explicit `REVOKE`. The Phase 6 lesson: Phase 3's
    default privileges grant DELETE on every new table.
- **Row-level security**, FORCE'd. `tasks` uses the tenant column. The two
  child tables have no tenant column (DOCUMENT 06 defines none), so their
  policies walk the parent task, the `work_schedule_days` pattern.
- **Proved** in `packages/db/test/phase7-rls.test.ts` (30 tests), run as
  `ufuq_app` with no WHERE clauses:
  - isolation in both directions;
  - no visibility with no tenant bound;
  - cross-tenant inserts, updates and moves refused;
  - every CHECK constraint;
  - `overdue` is not a value of the enum;
  - DELETE refused on `tasks`;
  - UPDATE and DELETE refused on `task_progress_updates`;
  - the same-company triggers;
  - a note with no employee record is accepted.

### `apps/api` — `src/tasks/`

| Method | Endpoint                         | Permission             |
| ------ | -------------------------------- | ---------------------- |
| GET    | `/tasks`                         | task.view              |
| POST   | `/tasks`                         | task.create            |
| GET    | `/tasks/summary`                 | task.view              |
| GET    | `/tasks/{id}`                    | task.view              |
| PATCH  | `/tasks/{id}`                    | task.update            |
| DELETE | `/tasks/{id}`                    | task.delete (soft)     |
| POST   | `/tasks/{id}/status`             | task.update_status     |
| POST   | `/tasks/{id}/progress-updates`   | task.add_progress_note |
| GET    | `/tasks/{id}/progress-updates`   | task.view              |
| POST   | `/tasks/{id}/checklist`          | task.update            |
| PATCH  | `/tasks/{id}/checklist/{itemId}` | task.update_checklist  |
| DELETE | `/tasks/{id}/checklist/{itemId}` | task.update            |

Every row of DOCUMENT 08 §4.7 is implemented. The business rules live in
one pure file, `task-rules.ts`, and the service calls them without restating
them:

- **Progress (rules 2 and 3, OD-10).** `computeProgress` uses `@ufuq/money`'s
  `Decimal`, rounding to the nearest hundredth. No value passes through a
  binary float, and the repository's lint rule against `toFixed` and
  `Math.round` applies to this code too. The service recomputes progress on
  every write that can change it (tick, untick, item added or removed, status
  change), in the same transaction, with the task row locked `FOR UPDATE`.
  Progress is never accepted from a client: sending `progress_percent` is a 422.
- **Transitions (rule 4)** are the DOCUMENT 13 matrix verbatim. Cancelling
  (rule 7) and reopening require a reason. Completing sets `completed_at`,
  and reopening clears it.
- **Completing with open items (rule 6)** is refused once with 409
  `TASK_HAS_OPEN_ITEMS`, carrying the count in `fields.open_items`. Sending
  `confirm_open_items: true` completes it. This is the Phase 6
  `NON_WORKING_DAY` pattern.
- **First activity (rule 5):** the first tick or first progress note moves
  `not_started` to `in_progress`, audited as `task.status_changed`. An untick
  never moves the status.
- **Overdue (rule 1)** is derived on every read against the **company's**
  calendar day. It is never stored and never settable. `?overdue=true|false`
  filters by it. `false` is written out explicitly so that tasks with no
  deadline are included.
- **Payload:** each task carries `is_overdue`, the checklist counts and
  `allowed_transitions`, so a screen offers only the moves the server will
  accept. Percentages are DECIMAL(5,2) strings (`"66.67"`).
- **Scope:** `self` is the tasks assigned to the caller, `team` the tasks
  assigned to their reports, `company` the tenant. The scope is part of the
  query. Filters are AND-ed with it, so a filter can never widen it.
- **The assignee must be an active employee inside the caller's scope.**
  - Outside the scope, or in another company: 422 `not_found`.
  - Deactivated: 422 `not_active`, rendered as "الموظف غير نشط" with a
    suggestion to reassign.
- **Department** defaults to the assignee's, can be overridden, and can be
  cleared.
- **Checklist editing:** `PATCH …/checklist/{itemId}` with `is_completed` is a
  tick. With `title` or `position` it also requires `task.update`, because
  DOCUMENT 13 gives editing the list to Admin/Manager. Reordering renumbers
  the positions densely.
- **Concurrent ticks** (DOCUMENT 13 edge case) are idempotent: ticking a
  ticked item succeeds and writes nothing.
- **`/tasks/summary`** returns counts by status, plus overdue and due today,
  in the caller's scope. The e2e suite checks each count against the matching
  filtered list's total.
- **Audit (DOCUMENT 21).** Every action is written in the same transaction as
  the change, against entity type `task`, so the task's history is one
  entity query:
  - `task.created`
  - `task.updated` — general fields, checklist ticks, renames and reorders
  - `task.reassigned`
  - `task.deadline_changed`
  - `task.status_changed`
  - `task.cancelled`
  - `task.reopened` — the reason is kept in the audit record
  - `task.deleted`
  - `checklist.item_added`
  - `checklist.item_deleted`
- **Errors:**
  - `INVALID_STATUS_TRANSITION` (422) and `TASK_HAS_OPEN_ITEMS` (409) are new
    codes, with messages in both languages.
  - `not_active` joins the closed field-issue vocabulary.
  - `company_id` in a query or body is 422.

### `apps/web`

| Route              | Screen                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `/admin/tasks`     | DOCUMENT 04 B8 — **table** and **board** views, toggled and held in the URL with every filter                       |
| `/admin/tasks/new` | DOCUMENT 04 B10 — create form with the checklist builder (add / remove / reorder)                                   |
| `/admin/tasks/:id` | DOCUMENT 04 B9 — header, status moves, edit, delete, checklist editor, progress timeline, record history            |
| `/app/tasks`       | DOCUMENT 04 C5 — the employee's list, grouped Due today · Overdue · In progress · Not started · Completed           |
| `/app/tasks/:id`   | DOCUMENT 04 C6 — tappable optimistic checklist, progress-note composer, status moves within the allowed transitions |

- **One detail screen serves both surfaces.** What the caller can do follows
  their permissions, and the API enforces it again.
- **Optimistic checklist:** a tick shows at once. On failure the item rolls
  back, an error is announced, and the task is reloaded (DOCUMENT 13 "Error
  states").
- **Status moves** are rendered from `allowed_transitions`:
  - The labels depend on the origin: Start, Resume or Reopen for
    `in_progress`.
  - Cancel and reopen open a reason dialog.
  - Complete with open items opens a confirmation naming the count. It also
    handles the server's 409, in case the checklist changed underneath.
  - An invalid transition shows the allowed list the server returned.
- **Progress notes** have no edit or delete control (rule 9). On a phone the
  composer is a bottom sheet (DOCUMENT 13 "Mobile behaviour").
- **Mobile layout:**
  - The table becomes stacked cards below 1024px.
  - The board becomes one full-width column at a time with scroll-snap, never
    shrunk to fit (DOCUMENT 13).
  - Filters move behind a button showing the active count (DOCUMENT 22).
- **Each status** is drawn by the existing `Badge` tones, and **progress** by
  a ring (cards and the header) or a bar (table rows). No new colours
  (RULE 22).
- **Overdue** is a separate badge beside the status, because it is not a
  status.
- **All four states** are on every screen:
  - **Loading:** skeleton.
  - **Empty:**
    - the admin list has two distinct empty states, nothing yet (with
      "Create task") and nothing matching (with "Clear filters");
    - board columns, the employee list, the checklist and the timeline each
      have their own.
  - **Error:** with retry, and a "not found" state for a 404 detail.
  - **Success:** a live-region notice after create, save, status change, note
    and delete.
- **Record history:** the DOCUMENT 21 task history panel shows for `audit.view`.
  The panel was extracted into `components/settings/record-history.tsx`, and
  `EmployeeHistory` is now a wrapper around it with unchanged behaviour, so
  the two panels cannot drift apart.
- **Strings:** every string is in both catalogues, and the parity test covers
  them. Audit sentences are verb-first in Arabic ("أنشأ {actor} مهمة").
- **Browser-pane check:** `ar` (RTL) and `en` (LTR) at desktop width and at
  375px, with no horizontal scroll. The mobile filter toggle shows the active
  count. No API or database runs in this environment, so the pane showed each
  screen's error state, and the populated layouts were not seen with data.
  The same limitation was recorded in Phase 6.

---

## Interpretations made (no blocking ambiguity)

Each of these follows from the documents or from an earlier phase's
precedent, and none adds a field, a transition or a permission:

- **Deadline audits:** every deadline change is audited as
  `task.deadline_changed`. Rule 11 requires this for overdue tasks; recording
  every change satisfies it and keeps the rule free of a time-of-edit
  condition.
- **Audit action for ticks, renames and reorders:** DOCUMENT 21 has no
  dedicated action for these, and DOCUMENT 21 forbids free-text actions. They
  are recorded as `task.updated`, with the item id in the values.
- **`task_progress_updates.created_by`** was added under DOCUMENT 06 §1.6.
  `employee_id` is nullable, because an administrator account need not have
  an employee record. The e2e suite proves an admin can post a note.
- **Bounds DOCUMENT 13 does not set:**
  - `description` at most 5000 characters;
  - the reason at most 1000, as in Phase 6;
  - at most 100 checklist items on `POST /tasks`.
- **Date range filter:** `from`/`to` filter on the deadline, the only date a
  task list is organised by. List order is fixed: deadline, then newest, then
  id. DOCUMENT 08 documents no sort whitelist for `/tasks`.
- **Employee list groups:** DOCUMENT 04 C5 names five groups. On-hold and
  cancelled tasks get their own groups at the end rather than vanishing from
  the employee's list.
- **Cancelled tasks:** cancellation is terminal for **status** only. No rule
  forbids ticking or noting on a cancelled task, so none was invented.

---

## Not built, deliberately

| Item                                                                                                         | Why                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tasks.goal_id`, the `goal_id` filter, the linked-goal UI, rule 8 (goal recalculation), goal-period warnings | Goals are Phase 8. The column is a foreign key to a table that does not exist yet. An unenforced UUID now is the shortcut Phases 4 and 6 refused (`leave_request_id`). Phase 8 adds the column with `ON DELETE SET NULL`, which DOCUMENT 13 specifies. Sending `goal_id` today is a 422. |
| Notifications on assignment, reassignment and completion (rule 10, FLOW 09/10 🔔)                            | Phase 15 (DOCUMENT 19). The audit half of rule 10 is built.                                                                                                                                                                                                                              |
| Board drag-and-drop between columns                                                                          | A DOCUMENT 24 "should have". Status moves are made on the task, where reasons and confirmations are shown.                                                                                                                                                                               |
| Bulk status change                                                                                           | DOCUMENT 04 B8 marks it V2.                                                                                                                                                                                                                                                              |

---

## Housekeeping

- `apps/api/src/app.module.ts` had an uncommitted change before this phase
  started: its module documentation comment was cut down to `* e`. It was
  restored to the baseline commit before `TasksModule` was registered.
- Running `next dev` for the browser check rewrote `apps/web/next-env.d.ts`
  and generated `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`. All three were
  reverted or removed, so the working tree holds only Phase 7 changes.
