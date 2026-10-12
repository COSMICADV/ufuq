# Phase 11 — Salary and payroll: status

**Roadmap reference:** DOCUMENT 25, Phase 11
**Exit criterion:** payroll can be generated, reviewed, approved, finalized and marked paid; deductions, bonuses and adjustments work; finalized lines never change and the database refuses to change them; salary history works across mid-period changes; exact decimal arithmetic is proven; net salary can never be negative; MANAGER has no payroll or salary access; an employee sees only their own; the Attendance and Leave finalized-period guards are live; audit stays post-commit.

**Status: COMPLETE.** Committed as `Complete Phase 11: Salary and Payroll`.

There is no open **[DECISION REQUIRED]**. Eleven decisions were needed: the three blocking ones from DOCUMENT 28 (OD-06, OD-07, OD-08), approved in the brief, and eight financial rules the documents left open. All eight were asked and answered before any calculation was written.

## Decisions applied

| Decision                   | Source              | What it means in code                                                                                                                                                                                                                                                                                     |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OD-06 — B**              | approved            | Net salary is never negative. A deduction, a generation or an adjustment that would produce a negative net is refused (422 `PAYROLL_NEGATIVE_NET`, or a blocking entry at generation) with the attempted figure. It is never capped and never carried forward. A `CHECK` also refuses it in the database. |
| **OD-07 — A**              | approved            | MANAGER holds no salary or payroll permission (DOCUMENT 02 already said so). Every payroll and salary read and write is checked server-side; a `team` scope, if one were ever granted, is refused rather than widened.                                                                                    |
| **OD-08 — A**              | approved            | No end-of-service module. A terminated employee's month is the normal pro-rated payroll up to the termination date.                                                                                                                                                                                       |
| **No default policy**      | approved this phase | Nothing is seeded. Salaries and payroll are refused (`SALARY_POLICY_NOT_CONFIGURED`) until an ADMIN saves a policy, and the first save must state every rule.                                                                                                                                             |
| **Pro-rating**             | approved this phase | Working-day share, per salary segment, whatever the daily-wage basis. A full month is the full salary.                                                                                                                                                                                                    |
| **Lateness rules**         | approved this phase | `none`, `per_minute` (minutes × the day's minute wage × multiplier), `fixed_per_incident` (amount × late days). Tiered is deferred.                                                                                                                                                                       |
| **Overtime**               | approved this phase | Paid-policy schedules only: overtime minutes × the day's minute wage × `overtime_rate`. Rest-day overtime has no rate: unpriced, flagged.                                                                                                                                                                 |
| **Rounding**               | approved this phase | `nearest` / `up` / `down` to the whole pound; `none` keeps piastres. Once, on the net.                                                                                                                                                                                                                    |
| **Half-day, pending**      | approved this phase | Worked days, no automatic deduction; pending days listed in the generation warning.                                                                                                                                                                                                                       |
| **Adjusted before paid**   | approved this phase | Mark-paid allowed from `adjusted` while `paid_at` is empty; status stays `adjusted`.                                                                                                                                                                                                                      |
| **When a month generates** | approved this phase | Only after its last day, in the company's timezone. Every non-deleted employee whose employment overlaps the month.                                                                                                                                                                                       |

The eight Phase 11 rules are written into DOCUMENT 15 ("Decided in Phase 11"). OD-06, OD-07 and OD-08 are marked decided in DOCUMENT 28.

**Interpretations** (the documents' own semantics, not new rules):

1. `scheduled_day_wage` (unpaid leave) is monthly salary ÷ the month's scheduled working days — the `scheduled_working_days` formula, whatever the basis.
2. A working day with no attendance record is absent (DOCUMENT 12 rule 10, what the nightly job writes), and listed in the warning.
3. A `pending` row with no check-in (the leave-cancellation placeholder) is not a worked day; it is treated like a missing record.
4. Returning an approved run to review is audited as `payroll.submitted_for_review` with old and new status: DOCUMENT 21 names no separate action, and none was invented.
5. `payroll_adjustments.approved_by` / `approved_at` (DOCUMENT 06) stay empty: no approval step for adjustments is documented.
6. A deduction's or bonus's `type` is an optional free label (default `other`); DOCUMENT 15 names the column, not its values.
7. Overnight schedules: Attendance has no overnight support (no flag exists), so payroll has nothing overnight-specific to handle.

---

## The calculation engine

`apps/api/src/payroll/payroll-engine.ts` is pure: no database, no clock. Its inputs are data (policy, salary rows, every calendar day with schedule, holiday and attendance), and the snapshot stores exactly those inputs.

- **Exact throughout.** Every intermediate amount is a `Fraction` of two bigints (`fraction.ts`). No JavaScript `number` touches money, and no division is rounded mid-way. 20,000 ÷ 26 stays `10000/13`.
- **Rounded once.** The net is rounded from the exact sum, per the policy. The stored components (base, daily wage, attendance adjustment) are shown at 0.01, half away from zero; the net is never computed from the shown components. A unit test proves the difference: with 100 ÷ 3 per day and two absences, the net is 33.33, where rounding each day first would have given 33.34.
- **Sequence** (DOCUMENT 15):
  1. salary segments clipped to the employment window (joining → termination), every employed day covered by exactly one row, else `salary_missing:<date>`;
  2. the month's scheduled working days (schedule weekdays minus holidays);
  3. base = Σ segment salary × segment working days ÷ month working days;
  4. daily wage per segment, from the basis;
  5. per day: worked (office / WFH), absent, paid leave, unpaid leave, lateness and overtime, each priced at the salary effective that day;
  6. net = base + attendance adjustment − deductions + bonuses, rounded once;
  7. review flags: zero attendance, pending days, missing days, unpriced overtime.
- **Recalculating a line after a deduction** re-nets from the exact base and attendance adjustment its snapshot kept (`renet`), so a deduction never re-reads attendance.
- **The employee estimate** runs the same engine for the current month, projecting days not yet reached as worked, and is always returned as `provisional: true`.

## Salary history

- `POST /employees/{id}/salary` closes the open row the day before the new one starts and inserts the new row. A new row must start after the latest one (`not_after_current`): a past row is never re-cut, a scheduled future row never silently replaced.
- The database refuses any change to a row except setting an open row's `effective_to`, once, and refuses overlapping rows, for every role including the table owner. DELETE is revoked.
- A change effective inside a finalized month is refused (`PAYROLL_PERIOD_FINALIZED`).
- Payroll uses every effective portion: a mid-month change is two segments, each priced separately and summed (e2e: 11 days at 20,000 and 12 at 26,000 = 532000/23 → 23,130.43).
- Audited as `employee.salary_changed`; `Idempotency-Key` replays.

## Generation, recalculation, entries

- **Generation** (`POST /payroll/periods`) runs pre-flight and every write in one transaction:
  - month not ended → 422; existing period → 409; no policy → 422;
  - missing salary, broken schedule or a negative net → 422 `PAYROLL_PREFLIGHT_BLOCKED`, fields keyed by employee id; nothing is created;
  - pending or missing attendance → 409 `PAYROLL_ATTENDANCE_INCOMPLETE` listing employees and dates, unless `proceed_with_warnings: true`;
  - totals are the exact sums of the stored lines.
- **`GET /payroll/periods/preflight`** answers the same questions without generating, for the generate dialog.
- **Concurrency:** the unique `(company_id, year, month)` plus `Idempotency-Key`. The key row is claimed first in the transaction with a pre-assigned resource id, so a concurrent request with the same key waits, fails the unique index, and replays the first result.
- **Recalculation** is draft only. Lines are rebuilt in place, keeping the Admin's deductions and bonuses; a line for an employee no longer in the month is removed unless it has entries (then refused). One transaction.
- **Deductions and bonuses**: draft or under review, amount > 0, reason ≥ 3 characters, creator stored, append-only. The line and period totals are rewritten in the same transaction; a negative net is refused with the figure.

## The state machine

`payroll-rules.ts` is the single table, unit-tested action by action against every state, and re-checked under a `FOR UPDATE` lock on the period:

```
draft ⇄ under_review ⇄ approved → finalized → paid
                                       ↘           ↘
                                        adjusted ←──
```

| From         | Allowed                                              |
| ------------ | ---------------------------------------------------- |
| draft        | recalculate · entries · submit for review            |
| under_review | approve · return to draft · entries                  |
| approved     | finalize · return to review                          |
| finalized    | mark paid · adjustments (→ adjusted)                 |
| paid         | adjustments (→ adjusted)                             |
| adjusted     | further adjustments · mark paid once if not yet paid |

Every other transition is a 409 (`PAYROLL_INVALID_TRANSITION`, `PAYROLL_LINE_LOCKED` or `PAYROLL_PERIOD_FINALIZED`).

## Finalization and immutability

- `POST /payroll/periods/{id}/finalize` with `{ "confirm": "YYYY-MM" }` (mismatch → 422). One transaction: lock the period, re-check it is approved, write each line's final snapshot (entries, exact net, the figures), lock every line, set the period finalized with `finalized_by` / `finalized_at`. Two concurrent finalizations: one 200, one 409 (e2e).
- The snapshot holds the policy, the schedule with its seven days, the holidays, the salary rows, the segments, every calendar day's attendance inputs, the counts and the exact amounts: a later policy, schedule or salary change cannot change what a finalized payslip means (e2e proves the figures unchanged after a policy change).
- **Three levels:**
  1. **State machine:** no action edits a locked state.
  2. **Service:** every write re-checks the line's lock and the period's state under the lock (e2e calls the service directly: refused).
  3. **Database** (migration `20261013000000_phase11_payroll`): a trigger refuses UPDATE and DELETE of a locked line for every role, the table owner included; a line is locked only by finalizing an approved period, in an update that changes nothing else; a period cannot be finalized with an unlocked line; a finalized period's figures never change and its status only moves forward; deductions and bonuses insert only on an editable line, adjustments only on a locked one; entries and adjustments are append-only (UPDATE/DELETE revoked). No database function writes to `payroll_lines` (checked in `pg_proc`).

## Adjustments

- `POST /payroll/lines/{id}/adjustments`: finalized, paid or adjusted periods only; a signed amount ≠ 0; a reason.
- The original line is never touched; the payslip shows `net_salary`, `adjustments_total` and the derived `adjusted_net`. The period becomes `adjusted`.
- The adjusted outcome may not go below zero (OD-06).
- Audited as `payroll.adjustment_created`; `Idempotency-Key` replays.

## Finalized-period guards (the Phase 10 handoff, closed)

One class, `PayrollPeriodGuard` (`payroll-period-guard.ts`, its own `PayrollGuardModule`), answers "does a finalized, paid or adjusted period contain these dates?". Nothing else queries payroll periods.

| Caller                                                  | Result                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Attendance admin adjustment                             | 409 `PAYROLL_PERIOD_FINALIZED`, `fields.periods: ["YYYY-MM"]`                 |
| Attendance correction approval                          | same                                                                          |
| Check-in / check-out                                    | same                                                                          |
| Nightly attendance job                                  | writes nothing into a locked month                                            |
| Leave submission, approval, approved-leave cancellation | 409 `LEAVE_PERIOD_FINALIZED` (the Phase 10 port, now bound to the real guard) |
| Salary change effective inside the month                | 409 `PAYROLL_PERIOD_FINALIZED`                                                |

Both messages direct the user to the adjustment flow. Leave checks the period before overlap and check-in, so a finalized month always answers first.

## Access

| Role     | Salary                          | Payroll                                                 |
| -------- | ------------------------------- | ------------------------------------------------------- |
| ADMIN    | company                         | everything, per permission                              |
| EMPLOYEE | own (`/employees/{own}/salary`) | own estimate, own finalized payslips; anything else 404 |
| MANAGER  | 403                             | 403                                                     |

Another company's period, line or salary is 404. The audit viewer withholds every value of a pay action (`payroll.*`, `deduction.added`, `bonus.added`, `employee.salary_changed`) from a caller without `employee.view_salary`. Events carry ids, never amounts.

## Audit and events

All twelve DOCUMENT 21 actions are written through `AuditDispatcher`, after commit: `employee.salary_changed`, `payroll.generated`, `payroll.regenerated`, `payroll.submitted_for_review`, `payroll.approved`, `payroll.returned_to_draft`, `payroll.finalized`, `payroll.marked_paid`, `payroll.adjustment_created`, `deduction.added`, `bonus.added`, `salary_policy.changed`. Events (`payroll_generated`, `payroll_finalized`, `payroll_marked_paid`, `payroll_adjustment_created`, `payroll_deduction_added`, `payroll_bonus_added`) go to `PAYROLL_EVENT_SINK` after the audit; delivery is Phase 15.

## Idempotency

`common/idempotency.ts` — a new `idempotency_keys` table, scoped to company, user and endpoint, 24 hours (DOCUMENT 08 §8). Same key and request: the original resource, nothing new. Same key, different request: 422 `IDEMPOTENCY_KEY_REUSED`. Used by generation, deductions, bonuses, adjustments and salary changes; e2e proves no duplicates for each, including two concurrent requests.

## Database — migration `20261013000000_phase11_payroll`

- Tables: `salary_policies`, `employee_salaries`, `payroll_periods`, `payroll_lines`, `payroll_deductions`, `payroll_bonuses`, `payroll_adjustments`, `idempotency_keys`; enums; the twelve audit actions.
- RLS (ENABLE + FORCE) on every table; same-company triggers on every reference; RESTRICT foreign keys; least-privilege grants.
- Columns DOCUMENT 06 does not name: timestamps; `payroll_periods.total_attendance_adjustment` (the run summary shows it); the `idempotency_keys` table.

## API

See DOCUMENT 08 §4.10 (amended): the documented endpoints, plus `GET /payroll/periods/preflight`, `POST …/return-to-draft`, `POST …/return-to-review` and `GET /payroll/lines`. Also `GET/PATCH /salary-policies` and `GET/POST /employees/{id}/salary`.

## Web

| Route                                   | What                                                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/payroll`                        | Periods with state, employee count, gross, deductions, bonuses, net; "Generate payroll" with the pre-flight report (blocking employees linked to their Salary tab, warnings to acknowledge). |
| `/admin/payroll/:periodId`              | Summary and lines; actions from the period's `abilities`; finalization dialog with irreversible wording and the typed period.                                                                |
| `/admin/payroll/:periodId/:employeeId`  | Payslip breakdown (segments, attendance figures, each deduction rule's amount), deductions, bonuses, adjustments; entry forms when allowed.                                                  |
| `/admin/settings/salary-policy`         | Exactly the documented settings; empty until saved; a confirmation that the policy shapes future and draft payroll only.                                                                     |
| Employee profile → Salary               | Current salary, history as stored, payslip history, "Change salary" (append-only explanation).                                                                                               |
| `/app/salary`, `/history`, `/:periodId` | Provisional estimate (labelled first), finalized payslips, own payslip detail.                                                                                                               |
| `/admin` dashboard                      | Payroll summary: latest period's state, gross, deductions, employee count (stored totals, nothing recalculated).                                                                             |
| `/app` dashboard                        | The salary estimate card, provisional, for a caller with own salary access.                                                                                                                  |

- **Finalization is not offered on mobile:** the button is not built below 1024px (`finalizationOffered` + `useIsDesktop`, unit-tested); the screen says to finalize on a computer instead. The server checks stay authoritative.
- On a tablet the run table scrolls inside its own box with the employee column frozen; on a phone it is stacked cards.
- Money is always shown with piastres; the browser does no money arithmetic.
- Forms keep the typed values on a server refusal, and every form submission carries one `Idempotency-Key` for the dialog's life.

**Browser check:** against a temporary local stack (the real API over PGlite, seeded with an August period finalized, paid and adjusted and a September draft), on the production build: the periods list, the run screen in English at 1024px (Finalize offered) and in Arabic RTL at 375px (Finalize not built, the desktop notice shown, no horizontal overflow), the admin payslip, and the employee salary screens. The check found three defects, all fixed before commit:

- a missing translation key (`payroll.lateness`, overwritten by a group of the same name) crashed the payslip page; a unit test now resolves every enum-driven payroll key in both languages;
- the employee estimate charged **today** as an absence when today had no record yet; the estimate now judges only days that have ended and projects today onward (e2e asserts the exact estimate);
- at tablet width the run table widened the page instead of scrolling in its own box; the card now shrinks, and the table scrolls with the employee column frozen.

Rechecked after the fixes: the admin payslip (Arabic, 375px), the employee estimate, history and payslip (and a draft period's payslip is not shown to the employee), and the run table at 768px (no page overflow, sticky first column, no Finalize).

## Deferred

| Item                                                     | Why                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Tiered lateness                                          | Approved decision: deferred                                                           |
| `monthly_salary` on `POST /employees` (DOCUMENT 08 §4.3) | Salary is set through `/employees/{id}/salary`; the create form was not in this brief |
| "Discard" draft (DOCUMENT 15 states table)               | Entries are append-only and payroll is never deleted; not in this brief               |
| Notification delivery                                    | Phase 15                                                                              |
| EOS / settlement, tax, loans, payslip PDF                | OD-08 A; DOCUMENT 15 "Future extensions"                                              |

---

## Verification results

| Command                       | Result                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm format:check`           | Pass                                                                                       |
| `turbo run lint --force`      | Pass — 0 errors; the same 4 existing `no-console` warnings in `packages/db/prisma/seed.ts` |
| `turbo run typecheck --force` | Pass — 15/15                                                                               |
| `turbo run test --force`      | Pass — 15/15, **1448 tests**                                                               |
| `turbo run build --force`     | Pass — 8/8; every new route builds                                                         |

| Package        | Tests    | Phase 11 additions                                                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `packages/db`  | 281      | **+35** — `test/phase11-rls.test.ts`                                                                                      |
| `apps/api`     | 830      | **+96** — `payroll-engine.test.ts` (31), `payroll-rules.test.ts` (14), `test/payroll.e2e.test.ts` (50), audit masking (1) |
| `apps/web`     | 224      | **+19** — `lib/payroll.test.ts`                                                                                           |
| other packages | 113      | — (i18n parity covers the new keys)                                                                                       |
| **Total**      | **1448** | **+150** (1298 at the start of the phase)                                                                                 |
