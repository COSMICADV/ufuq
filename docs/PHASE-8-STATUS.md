# Phase 8 — Goals & performance: status

**Roadmap reference:** DOCUMENT 25, Phase 8
**Exit criterion:** _performance scores are computed entirely from
configuration, with no weight or coefficient present in code._

**Status: COMPLETE.** Every documented Phase 8 requirement is built and
tested, and the work is committed as `Complete Phase 8: Goals and
Performance`. The legitimate deferrals are listed under "Deferred by phase".
The Task-goal counting rule is approved (see "Task goal counting rule — V1,
approved"), and the employee dashboard `/app` now carries the "My goals"
section (DOCUMENT 04 C1, DOCUMENT 14).

Phase 7 was verified first, with no changes needed. It is commit `2e257d9`
(`Complete Phase 7: Tasks and Checklists`), and every check passed on the
clean tree.

| Clause                                          | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **scores computed entirely from configuration** | **Over HTTP** (`goals.e2e`): one employee's March is scored with the stored default model, then re-scored under two other saved configurations. The results are exactly what each configuration implies: attendance-only gives 85.71, the attendance score with zero penalties; on-time-only gives 50.00. **In the engine** (`performance-rules.test.ts`): DOCUMENT 14's worked example comes out at 87.32. Weighting attendance at 0.5 gives 90.57. Each single-component configuration returns exactly that component. |
| **no weight or coefficient in code**            | The default model exists only as data. The migration writes it into each company's `performance_config` row, and a trigger on `companies` writes it for new companies. The engine reads the row and holds no number a company could want changed. A source test strips comments from `performance-rules.ts` and fails on: any decimal literal; any of DOCUMENT 14's defaults (`0.3`, `0.4`, `0.6`, `5.0`, `1.0`); or any integer other than `0`, the scales `2` and `6`, and the percentage base `100`.                  |

---

## Task goal counting rule — V1, approved

A task contributes to a Task goal only when **all** of these hold:

1. it is **explicitly linked** to the goal (`tasks.goal_id`);
2. it **belongs to the goal owner** — its assignee is the goal's employee;
3. its **status is `completed`**;
4. its **`completed_at` falls within the goal period**, judged in the company's timezone, from the first instant of `period_start` to the end of the effective last day (`period_end`, or the termination date for an owner terminated mid-period);
5. its priority is one the goal's `task_count_rule` names. The rule is `{ "version": 1, "priorities": [...] }`. **The priority filter is optional: when no priority is selected — `priorities` omitted or `[]`, or no rule sent at all — every priority counts.** The rule is stored with all four priorities in that case, so a stored rule is always explicit.

Soft-deleted tasks never count. The value is always re-derived by counting, never incremented.

**Where it lives:** `GoalLedgerService.qualifyingWhere` (`apps/api/src/goals/goal-ledger.service.ts`) is the single population, used for both the value and the detail screen's per-task "counts" flag. `parseTaskCountRule` (`goal-rules.ts`) is the rule parser.

**What changed at approval** (the rest already behaved this way):

- **Empty selection.** The parser previously refused an empty or absent `priorities`. It now reads that as "all priorities", and the admin form no longer blocks submission when every box is cleared. The helper text says so in both languages.
- **Owner condition in the count itself.** Ownership was previously guaranteed only by link validation: a task can link only to its assignee's goal, and reassigning a linked task requires relinking. The count query now also requires `assignee = goal owner`, so the rule does not rest on that validation alone.

**Tests:** `goal-rules.test.ts` (empty and absent selection mean all four; malformed values are still refused), `goals.e2e` "the approved V1 rule" (an empty selection over HTTP is stored as all four, and a low-priority task counts; a linked task moved to another employee directly in the database stops counting, both in the detail flag and on the next recalculation), and web `goals.test.ts` (`countedPriorities`, and the create and edit bodies).

---

## Database — migration `20261006000000_phase8_goals_performance`

DOCUMENT 27 RULE 31 migration implications are at the top of the file. It is
a new migration; no earlier one is edited.

- **`goals`** (DOCUMENT 06 §3.18):
  - the enums `goal_type` and `goal_status`;
  - DECIMAL(15,2) target and current values;
  - soft delete;
  - DOCUMENT 14's two indexes.
- **CHECK constraints on `goals`:**
  - target > 0;
  - current ≥ 0;
  - `period_end > period_start`, strictly;
  - `task_count_rule` present exactly when `type = 'task'`, and always a JSON object;
  - non-blank title and unit.
- **`goal_progress`** (§3.19), append-only, with these guards:
  - The app role has no UPDATE or DELETE (REVOKE).
  - A trigger refuses UPDATE and DELETE for every role, the owner included.
  - The foreign key to `goals` is RESTRICT, so a goal's history cannot be removed out from under it.
  - It carries `target_value` — the target in effect when the row was written (DOCUMENT 14 "Target changed mid-period").
- **`tasks.goal_id`** (deferred from Phase 7):
  - `ON DELETE SET NULL` (DOCUMENT 13);
  - index `(goal_id, status)`;
  - the Phase 7 same-company trigger is widened to check it.
- **`performance_config`**:
  - one row per company (unique), with JSONB `config` and `schema_version`;
  - existing companies are backfilled, and a `SECURITY DEFINER` trigger on `companies` covers new ones;
  - the database-written row gets a time-ordered UUID v7 key (OD-12 layout);
  - the app role may only SELECT and UPDATE.
- **Same-company triggers** on all new references, plus row-level security on all three tables. `goal_progress` reaches its tenant through the goal.
- **`audit_action`** gains the five DOCUMENT 21 goal actions and `settings.performance_weights_changed`.
- **Proved** in `packages/db/test/phase8-rls.test.ts` (35 tests), including the backfill of a pre-existing company.

## API

| Method | Endpoint                      | Permission                   |
| ------ | ----------------------------- | ---------------------------- |
| GET    | `/goals`                      | goal.view                    |
| POST   | `/goals`                      | goal.create                  |
| GET    | `/goals/{id}`                 | goal.view                    |
| PATCH  | `/goals/{id}`                 | goal.update                  |
| DELETE | `/goals/{id}`                 | goal.update (cancels)        |
| POST   | `/goals/{id}/progress`        | goal.update_progress         |
| GET    | `/goals/{id}/progress`        | goal.view (history)          |
| GET    | `/performance-config`         | settings.view                |
| PATCH  | `/performance-config`         | settings.performance_weights |
| GET    | `/employees/{id}/performance` | report.employee_monthly      |

Every rule is written once:

- **`goals/goal-rules.ts`** (pure). It holds:
  - the progress formula, as a true value on big-integer arithmetic so over-achievement such as 112% is kept;
  - the display cap at 100;
  - milestone detection at 25 / 50 / 75 / 100, which fires on upward crossings only;
  - the status derivation: active until the effective last day, then achieved at ≥ 100% or missed;
  - period validation and overlap;
  - the closing date and elapsed-portion target for an owner terminated mid-period;
  - the `task_count_rule` parser.
- **`goals/goal-ledger.service.ts`** is the only writer of a goal's value and status:
  - It appends history, audits, and settles the status.
  - It re-derives a Task goal's value **from its tasks**, rather than incrementing it.
  - It locks the goal row `FOR UPDATE`.
  - `GoalsService`, `TasksService` and the period-end job all call it.
- **Task ↔ goal (DOCUMENT 13 rule 8):**
  - **Validation.** A task may link to a goal of the same company and the same employee. A foreign goal is `not_found`, another employee's goal is `not_same_employee`, and a cancelled goal is `cancelled`. Reassigning a linked task requires relinking or unlinking it.
  - **Recalculation.** Completing, reopening, deleting, relinking or re-prioritising a linked task recalculates the goal **in the same transaction**. The e2e suite proves this by forcing a goal-history insert to fail: the task's status change rolls back with it.
  - **Warnings.** A deadline outside the goal's period, or a closed goal, returns the warning `goal_outside_period`.
  - **Payload and filter.** Each task carries `goal`, and `GET /tasks?goal_id=` filters by it.
- **Manual progress** is accepted for Sales and Custom goals only:
  - Task goals return 422 `GOAL_PROGRESS_AUTOMATIC`.
  - Employees hold no `goal.update_progress` (DOCUMENT 02), so they are refused (403).
  - Any change to a cancelled goal returns 422 `GOAL_CANCELLED`.
- **Period end** (DOCUMENT 14 rule 7):
  - `GoalLifecycleService` runs on an hourly BullMQ job, judging each company against its own day.
  - It is idempotent and audited as `goal.updated` by the company's system actor.
  - Every write also settles the status, so a late figure turns `missed` into `achieved`, and extending a closed goal's period reopens it. History is never deleted.
- **Milestones are detected, and delivery waits for Phase 15:**
  - Events are handed to a `GOAL_EVENT_SINK` port **after commit**; nothing is published for a rolled-back change.
  - The interim sink only logs at debug level; Phase 15 replaces it with real delivery.
  - The progress response also returns `milestones_crossed`.
- **Performance:**
  - `performance/performance-config.ts` validates a version-1 document:
    - each weight is 0–1 and the three sum to exactly 1;
    - the task sub-weights are 0–1 and sum to exactly 1;
    - penalties are 0–100;
    - values are strings only (never JSON numbers), with Arabic-Indic digits normalised;
    - every problem is reported by its path, and a wrong sum as `must_sum_to_one`.
  - `performance-rules.ts` computes the DOCUMENT 14 model:
    - a missing component is `null` and the remaining weights are renormalised;
    - the same principle applies inside the task score;
    - nothing left to weigh means `overall: null` ("no data"), never 0%.
  - A save audits only the keys that changed.
- **Scope** (DOCUMENT 09 §4):
  - Another company's goal or employee is 404.
  - An in-tenant goal outside `goal.view`, or an action outside its own scope, is 403.
  - A manager reaches their direct reports; an employee reaches themselves.

## Web

| Route                          | Screen                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/admin/goals`                 | DOCUMENT 04 B11 list: name, type, owner, target, current, progress, period, status. Type and status filters live in the URL.                                                   |
| `/admin/goals/new`             | B11 create form: type, owner, target and unit by type, period, and the counting rule for Task goals. `?employee=` preselects the owner.                                        |
| `/admin/goals/:id`             | B12: progress chart drawn against each row's own target; history; linked tasks marked as counting or not; actions (update progress, edit, cancel); the record's audit history. |
| `/app`                         | DOCUMENT 04 C1, built minimally for the modules that exist: the date, the attendance card, "My tasks" and "My goals". See "Employee dashboard" below.                          |
| `/app/goals`, `/app/goals/:id` | The employee's goal cards and the read-only C7 detail, which shows the contributing tasks.                                                                                     |
| `/admin/settings/performance`  | B25: weights and sub-metrics with live sums. A save is blocked while a sum ≠ 1, with the sum shown, and the historical-reports warning is displayed.                           |

The goal and performance work also touches existing screens:

- **Employee profile:** an "Assign goal" quick action, a **Goals tab** of goal cards, and a performance snapshot on the Overview tab. The snapshot shows "No data" (لا توجد بيانات) rather than 0%.
- **Admin dashboard:** B1 widget 6, "Goal progress" — the top 5 active goals by nearest period end.
- **Tasks:**
  - the task form gets a linked-goal select limited to the assignee's goals, with a warning when the deadline falls outside the goal's period;
  - the task detail shows the linked goal;
  - the task list gets a goal filter.

**Employee dashboard (`/app`, DOCUMENT 04 C1):** No earlier phase had built `/app`, so it is created with only what existing modules can fill (DOCUMENT 27 RULE 26):

- **The date and the attendance card** (C1 components 1–2). It is the same `AttendanceCard` as `/app/attendance`. It loads first and on its own, with its own error state and no buttons whose result is unknown. The greeting carries no name, because the session payload has none.
- **My tasks** (component 3): due today, overdue, in progress and completed counts, plus the next 3 open tasks by deadline. Counts come from `meta.total` of filtered `GET /tasks` calls, so they are exact rather than limited to one page. The existing `TaskCard` is reused.
- **My goals** (component 4): the employee's **active** goals, nearest period end first (the API's order), up to 5, with an "All my goals" link to `/app/goals`. Each is the existing `GoalCard`, with:

  - a progress bar capped at 100%;
  - the true figure ("112% of target");
  - current and target values with unit;
  - days remaining;
  - a link to `/app/goals/:id`.

  No goal logic is duplicated: progress comes from the API.

- **States:**
  - **Loading:** attendance loads separately; tasks and goals load together.
  - **Error:** tasks and goals have one error state with retry.
  - **Empty:** C1 "Empty" — a welcome card when the employee has neither tasks nor active goals. Each section also has its own empty line.
  - **Success:** as above.
- **Not built:** salary, leave balance and requests (C1 components 5–7) arrive with Phases 11, 10 and 9. They are not shown as placeholders.
- **Pure rules** live in `lib/employee-dashboard.ts`, with tests.
- **Browser-pane check:** `ar` (RTL) and `en` (LTR) at 375px, with no horizontal scroll. With no API running, the screen shows the attendance card's own error and the sections' error with retry.

**Bar and true figure:** progress is drawn with the existing bar and capped at 100%. The true figure is written beside it ("112% of target"), and a percentage-unit goal shows both of its numbers ("84%" and "93.33% of target").

**Styling:** existing design-system components and tokens only, with a few appended goal styles and no redesign.

**States:** all four on every screen, including two distinct empty states on the list.

**Browser-pane check:** `ar` (RTL) and `en` (LTR) at desktop width and at 375px, with no horizontal scroll. As in Phases 6–7, no API or database runs in this environment, so the pane showed each screen's error state with retry; the populated layouts were not seen with data.

---

## Interpretations made

Each of these follows from the documents or from an earlier phase's precedent.

1. **`task_count_rule` (version 1)** — **approved**; see "Task goal counting rule — V1, approved" above. The rule is versioned, so another shape can be added later without reinterpreting stored rules.
2. **`DELETE /goals/{id}` cancels the goal.** DOCUMENT 14's actions list "Cancel" and no delete, and DOCUMENT 06 §6 keeps goals as history. A cancelled goal stays readable with its history.
3. **In-tenant, out-of-scope goal = 403.** DOCUMENT 09 §4 governs here. The Phase 7 approval of 404 applied to tasks only, and DOCUMENT 14 says nothing on this.
4. **Status is derived from value and date**, not stored as a one-way transition. This is what makes DOCUMENT 14 rule 9 work: recalculation or reopening re-derives the status, and history is only ever appended.
5. **A target change appends a history row** (same value, new target, source `manual`) and is audited as `goal.target_changed`. This keeps the chart honest across the change.
6. **A goal created for a period that has already ended** is closed at once (rule 7). A later figure can still turn it `achieved`.
7. **Units:**
   - A Sales goal's unit is the company currency. It is filled in when omitted, and any other currency is refused.
   - A Task goal's unit is `tasks`, and its target must be a whole number.
   - A Custom goal's unit is free text of up to 20 characters.
8. **Overlapping goals** of the same type are allowed and warned (`warnings: ["overlapping_goal"]`), per DOCUMENT 14 rule 8.
9. **"Possibly misconfigured"** marks a Task goal that no task could count toward: nothing is linked, uncancelled and of a counted priority.
10. **Owner terminated mid-period.** The goal closes at the termination date and is judged against the elapsed share of its target (days inclusive). Termination cannot yet be set through any V1 screen, so this is proved at unit level.
11. **Attendance score:**
    - It covers scheduled working days that have ended (to yesterday, in the company's zone), within employment.
    - Working days come from the employee's schedule and the company's holidays.
    - A present, late, half-day or pending day counts as attended — WFH by its `work_mode`, otherwise present. `late` is a late incident, `absent` an absence, and `on_leave` paid leave.
    - The attended share is capped at 100% before penalties, as in DOCUMENT 14's own worked example.
    - Because attended days are counted only on working days, the share cannot exceed 100% anyway. The doc's formula and its worked example therefore never disagree.
    - It returns no data in three cases: no working day in the window, an incomplete schedule, or no record at all (DOCUMENT 14 "month with no data").
12. **Task score:**
    - It counts the employee's uncancelled tasks due in the month. A task with no deadline belongs to the month it was created in.
    - "On time" means completed on or before the deadline's day.
    - With nothing completed, the on-time rate is missing and is renormalised away.
13. **Goal score:** the employee's uncancelled goals overlapping the month, each at the value its history held at month end. The current month is marked `is_provisional`.
14. **Bounds DOCUMENT 14 does not set:**
    - goal description ≤ 5000;
    - progress note ≤ 1000;
    - penalties ≤ 100 points;
    - weights to 4 decimal places.
15. **Clock for history rows.** Goal and history rows are stamped from the application clock, the same clock as their v7 ids and the status decisions taken beside them. History is read back by that instant.

## Deferred by phase

| Item                                                                                                            | Why                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Milestone and `goal_assigned` **notification delivery**                                                         | DOCUMENT 19 is Phase 15. Detection is built and published after commit to `GOAL_EVENT_SINK`; Phase 15 replaces the deferred sink. |
| Monthly report snapshot (with the weights in effect stored inside it), `/reports/goals`, `/reports/performance` | DOCUMENT 18, Phase 12. `GET /employees/{id}/performance` returns the configuration it used, so a snapshot can store it.           |
| Paid versus unpaid leave in the attendance score                                                                | Leave types are Phase 10. Until then every `on_leave` day is treated as paid leave; Phase 10 can tighten this.                    |
| `/app` C1 components 5–7: salary, leave balance, pending requests                                               | Payroll is Phase 11, leave Phase 10, requests Phase 9. `/app` renders only the components whose modules exist.                    |

---

## Verification results

| Command                       | Result                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`           | Pass                                                                                                                                                    |
| `turbo run lint --force`      | Pass — 0 errors (the same 4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`)                                                         |
| `turbo run typecheck --force` | Pass — 15/15                                                                                                                                            |
| `turbo run test --force`      | Pass — 15/15, **1137 tests**                                                                                                                            |
| `turbo run build --force`     | Pass — 8/8; `/app`, `/admin/goals`, `/admin/goals/new`, `/app/goals` and `/admin/settings/performance` prerender in `ar` and `en`; `:id` routes dynamic |
| `pnpm verify`                 | Not run — it needs real PostgreSQL and Redis, and Docker is not available in this environment                                                           |

The affected suites ran first: `phase8-rls`, `goal-rules`, `performance-rules`, `goals.e2e`, `tasks.e2e`, web `goals`, `employee-dashboard`, `performance`, `tasks` and `settings-nav`, and i18n catalogue parity. The full set ran after them. The final completion pass (counting rule, `/app`) re-ran the whole set on the final tree.

### Phase 8 exit checks

| Area                                                                                                | Confirmed by                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sales, Task and Custom goals; manual progress for Sales/Custom only; automatic Task-goal progress   | `goals.e2e` "creating goals", "manual progress", "Task goals derive their value…"                                                                                                                                                                                                                                                                                                                                |
| Append-only `goal_progress`                                                                         | `phase8-rls` (REVOKE and trigger refuse UPDATE/DELETE for every role; RESTRICT FK); `goals.e2e` history assertions                                                                                                                                                                                                                                                                                               |
| Milestones, period-end achieved/missed, cancellation, target changes, over-achievement              | `goal-rules.test.ts`; `goals.e2e` "manual progress", "editing", "cancelling", "period end"                                                                                                                                                                                                                                                                                                                       |
| Task complete / reopen / delete / relink / re-prioritise recalculation, atomic with the task change | `goals.e2e` "Task goals derive…" (including the forced-failure rollback)                                                                                                                                                                                                                                                                                                                                         |
| `performance_config`, `GET`/`PATCH /performance-config`, `GET /employees/{id}/performance`          | `goals.e2e` "performance configuration", "employee performance"                                                                                                                                                                                                                                                                                                                                                  |
| Attendance, task, goal and overall scores; missing-component renormalisation; no-data = `null`      | `performance-rules.test.ts`; `goals.e2e` "employee performance"                                                                                                                                                                                                                                                                                                                                                  |
| **No hardcoded weight, penalty, threshold or coefficient**                                          | `performance-rules.test.ts` source scan. A manual sweep of `apps/api/src/performance/*` and the web performance files finds no default weight or penalty in code: the defaults exist only as data, in the migration's `performance_config` rows and the trigger on `companies`. The remaining literals are scales (2, 6), the percentage base (100), validation bounds (weight 0–1, penalty 0–100) and counters. |
| Permissions, ownership scope, tenant isolation, RLS, foreign tenant = 404, audit                    | `goals.e2e` "permission matrix and scope" and audit assertions throughout; `phase8-rls`                                                                                                                                                                                                                                                                                                                          |

### Test totals

| Package           | Tests    | Phase 8 additions                                                                                                              |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `packages/auth`   | 44       | —                                                                                                                              |
| `packages/config` | 20       | —                                                                                                                              |
| `packages/i18n`   | 20       | — (parity now covers 164 new keys in both languages)                                                                           |
| `packages/money`  | 25       | —                                                                                                                              |
| `packages/db`     | 200      | **+35** — `test/phase8-rls.test.ts`                                                                                            |
| `apps/api`        | 639      | **+94** — `test/goals.e2e.test.ts` (42), `src/performance/performance-rules.test.ts` (28), `src/goals/goal-rules.test.ts` (24) |
| `apps/web`        | 185      | **+21** — `lib/goals.test.ts`, `lib/performance.test.ts`, `lib/employee-dashboard.test.ts`                                     |
| `apps/mobile`     | 4        | —                                                                                                                              |
| **Total**         | **1137** | **+150** (987 at the end of Phase 7)                                                                                           |

---

## Housekeeping

- **A latent e2e flake was fixed.** Each e2e suite now calls `app.listen(0, '127.0.0.1')` in place of `app.init()`.
  - **Cause.** Given a server that is not listening, supertest starts it for each request and closes it afterwards. On Node 24, a request that starts while that close is in progress fails with "socket hang up".
  - **When it surfaced.** Adding a ninth parallel e2e suite made it surface: once in `goals.e2e` and once in Phase 7's `tasks.e2e`.
  - **Scope.** The change is one line per file, test harness only. Three consecutive full API runs then passed.
- **Prisma formatting.** `prisma format` realigned the existing `AuditAction` enum column while adding the new values. The change is whitespace only.
- **Final browser check** used `next start` on the production build, not `next dev`, so no files were generated or rewritten.
- **`next dev` side effects.** The browser check's `next dev` rewrote `apps/web/next-env.d.ts` and generated `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`. All three were reverted or removed.
