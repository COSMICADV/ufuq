# Phase 12 — Reports: status

**Roadmap reference:** DOCUMENT 25, Phase 12 — executed after Phases 13 and 14, as the roadmap's dependency map requires.
**Exit criterion:** every report in DOCUMENT 18 returns correct figures that reconcile with the source modules.

**Status: COMPLETE.** Committed as `Complete Phase 12: Reports`.

All eight company reports, all five employee monthly sections, the monthly snapshot (persisted, scheduled, on demand, explicitly regenerated, with a proven "underlying data changed" flag), CSV export (synchronous and background), print, the 20/hour rate limit, and the admin and employee screens.

Phase 15 (Notifications) and Phase 16 were **not** started. The UFUQ Visual Identity V2 was **not** applied: the screens use the current design system.

## Decisions applied

| Question                     | Answer                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /reports/warehouse`     | **Added** (approved documentation/API correction). DOCUMENT 08 §4.12 updated.                                                                                                                                      |
| On-demand snapshot endpoints | **`POST /reports/employee/{id}/monthly/{year}/{month}/generate`** and **`…/regenerate`** (approved policy). DOCUMENT 08 §4.12 updated.                                                                             |
| Generate / regenerate scope  | Generate a missing snapshot: ADMIN company, MANAGER team, EMPLOYEE self. Regenerate an existing one: ADMIN company, MANAGER team — **never** EMPLOYEE.                                                             |
| Snapshot audit actions       | **`report.snapshot_generated`** and **`report.snapshot_regenerated`** (minimum canonical additions). DOCUMENT 21 amended. `report.exported` was in DOCUMENT 21 but never in the database enum; this phase adds it. |
| Stale-data detection         | A **source fingerprint**: the SHA-256 of the snapshot content as computed from the sources, stored with the snapshot and recomputed on every read.                                                                 |
| Export formats               | **CSV** (V1 MUST HAVE). Excel (SHOULD) and PDF (NICE TO HAVE) were not built.                                                                                                                                      |

No question was left open: there is no **[DECISION REQUIRED]**.

## Endpoints

| Method | Path                                                       | Permission                                                   |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------ |
| GET    | `/reports/attendance`                                      | `report.team` (company scope for `report.company`)           |
| GET    | `/reports/performance`                                     | `report.team`                                                |
| GET    | `/reports/tasks`                                           | `report.team`                                                |
| GET    | `/reports/goals`                                           | `report.team`                                                |
| GET    | `/reports/payroll`                                         | `report.company`                                             |
| GET    | `/reports/inventory`                                       | `report.company`                                             |
| GET    | `/reports/warehouse`                                       | `report.company` — **added**                                 |
| GET    | `/reports/stock-movements`                                 | `report.company`                                             |
| POST   | `/reports/{key}/export`                                    | `report.export` **and** the report's own read                |
| GET    | `/reports/exports/{id}`, `…/download`                      | `report.export`, the requester only — **added**              |
| GET    | `/reports/employee/{id}/monthly?month=YYYY-MM`             | `report.employee_monthly`                                    |
| POST   | `/reports/employee/{id}/monthly/{year}/{month}/generate`   | `report.employee_monthly` — **added**                        |
| POST   | `/reports/employee/{id}/monthly/{year}/{month}/regenerate` | `report.employee_monthly`, company or team scope — **added** |
| GET    | `/employees/{id}/monthly-reports`                          | `report.employee_monthly` (DOCUMENT 08 §4.3)                 |

Every report answers the same self-describing shape, `{ report, summary, groups, trend, rows, pagination }`:

- `report` holds the key and the scope: `company`, or `team` with the manager's employee id. A team report says it is a team report.
- It also holds the range, every active filter with the names its ids refer to, the company timezone, `generated_at`, and `provisional` with a reason.
- Summaries, breakdowns and trends cover the whole filtered set. Rows are paged.

**Filters.**

- Each report takes its own set: the common date range, department, employee and status, plus work mode, priority, goal type, location, product category, product, product status, movement type and user, where they apply.
- A filter a report does not take is **422 `not_allowed`**, never silently ignored, because the output states its filters. An unknown field is 422.
- The range defaults to the current month in the company's calendar.
- A range longer than 12 months is **409 `REPORT_RANGE_CONFIRMATION_REQUIRED`** until it is resent with `confirm_large_range=true`.

## Source reconciliation — how each figure is read

Reports keep no parallel truth. The only persisted reporting data is the monthly snapshot (and export job records). No summary table was needed: the scale test below met the target without one.

### Attendance

Source: `attendance_records`, by their **stored** statuses. Nothing is re-derived from today's schedule.

- **Working days:** records that are not `weekend` or `holiday`.
- **Present:** the attended statuses (`present`, `late`, `half_day`, `pending`), the same set the performance engine counts. **Office** and **WFH** split them by work mode.
- **Late:** `late`. **Absent:** `absent`. **Leave:** `on_leave`.
- Days not yet recorded are not counted.
- One `GROUPING SETS` scan gives the per-employee and per-trend-bucket counts. Departments are summed from the per-employee rows.

### Performance

`monthlyPerformance` (`performance/performance-month.ts`) is **the** calculation. It was extracted from the Phase 8 service (behaviour unchanged: Phase 8's 42 e2e and 28 engine tests pass) and given set-based reads:

- a fixed number of queries for any headcount;
- the latest goal history per goal is one `DISTINCT ON` query, not one query per goal.

`GET /employees/{id}/performance`, the performance report and the snapshots all call it. A range is read month by month. The department comparison is the mean of the canonical overall scores that exist; components with no data stay `null`.

### Tasks

The tasks counted are those **due** in the range: by deadline, or by creation day in the company zone when there is none. This is the performance engine's window.

- **Assigned:** every such task except a cancelled one.
- **Overdue:** DOCUMENT 13 rule 1 against the company's today.
- **On time:** completed on or before the deadline's day, read in the company zone. Rates use the engine's own `percentRate`.
- **By department:** the assignee's department.

### Goals

The goal module's own `goalMeasures`: the current value over the effective target, uncapped. A row therefore equals `GET /goals/{id}`.

The achievement rate is achieved ÷ (achieved + missed): the decided goals.

### Payroll

The stored `payroll_lines`: base (DOCUMENT 15's gross, the sum behind `total_gross`), attendance adjustment, deductions, bonuses and net. Appended `payroll_adjustments` give `adjustments_total` and `adjusted_net`, as the payslip shows them. Nothing is recalculated.

A period that is not finalized, paid or adjusted marks its rows and the report **provisional**. Month over month is the change in adjusted net between consecutive periods.

### Inventory

`product_stock`, the Phase 14 reconciled cache of the ledger. Value is Σ(quantity × weighted-average cost), exact, **rounded once** (`ROUND` on NUMERIC is half away from zero, like `@ufuq/money`'s `nearest`). This is the dashboard's `stockValue`.

- Stock status is judged on the product's company-wide total (the approved Phase 14 basis).
- Low and out counts cover active products, as the dashboard counts them.
- It is the stock as it stands, so it has no date range.

### Warehouse

Per location: the non-zero balances (products held, units, value), as the location list computes them, plus the movement count and the units in and out in the range. The trend is daily, or monthly for long ranges.

### Stock movements

The ledger rows through the ledger endpoint's own `movementLedgerWhere` (extracted from Phase 13's `GET /stock-movements`, behaviour unchanged). Exact DECIMAL strings, newest first by `sequence`, always paged. Breakdowns by type and by user.

**Proven in `test/reports.e2e.test.ts`.** Every figure is asserted twice: against totals computed from the seed, and against the source module's own endpoint.

| Report      | Reconciled against                                                                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attendance  | Seeded records per employee (e.g. 88 working days, 84 present = 82 office + 2 WFH, 2 late, 1 half day, 2 absent, 2 leave from the leave module), department sums, and `GET /employees/{id}/performance` inputs. |
| Tasks       | Seeded tasks, including two completions both on 10 April in UTC — one on time and one late in Cairo; `GET /tasks?overdue=true`; the performance task inputs and rates.                                          |
| Goals       | `GET /goals/{id}` progress, current value and status for every row; over-achievement 120.00%.                                                                                                                   |
| Performance | `GET /employees/{id}/performance` for every employee: every score, overall and effective weight.                                                                                                                |
| Payroll     | `GET /payroll/periods/{id}` for every line (base, adjustment, deductions, bonuses, net, adjustments, adjusted net); period sums equal stored period totals; month-over-month change.                            |
| Inventory   | `GET /warehouses/dashboard` (value 4640.63, low 2, out 1), `GET /products/{id}` totals, `GET /inventory/alerts`, `GET /warehouses` stock value per location.                                                    |
| Warehouse   | Location stock value and the ledger's movement volume; a transfer leaves the company total unchanged.                                                                                                           |
| Movements   | `GET /stock-movements`: same ids, same order, same exact strings.                                                                                                                                               |

## Monthly employee report snapshots

**Schema.** Migration `20261016000000_phase12_reports` creates `monthly_employee_reports`. It has the DOCUMENT 06 §3.27 columns, plus three added by documented amendment: `generated_by`, `source_fingerprint` and `revision`.

**Integrity in the database** (`packages/db/test/phase12-rls.test.ts`):

- RLS (ENABLE + FORCE) and same-company references for the employee and generator.
- One row per `(employee_id, year, month)`.
- No DELETE: the grant is revoked and a trigger refuses it, for the owner too.
- An UPDATE is accepted **only** as a regeneration: the next revision, a later `generated_at`, the same employee and month. A silent rewrite is refused even for the owner.

**Content** (`snapshot-content.ts`) is computed for any number of employees in a fixed number of queries, by the same SQL and calculation as the company reports:

- **Attendance:** working days, present, office, WFH, late, half day, absent, leave.
- **Tasks:** assigned, completed, in progress, not started, on hold, cancelled, overdue, on time and rates.
- **Goals:** progress per goal at month end, as the performance calculation saw it.
- **Salary:** the month's payroll line (base, attendance adjustment, deductions, bonuses, net, adjustments, adjusted net).
  - With a period that is not final, `is_provisional` is true.
  - With no payroll for the month, `source: "none"` and provisional. Payroll is never computed here.
- **Performance:** the full calculation, including the configuration and weights in effect.
- `overall_score`; `is_provisional` = salary provisional or the month not ended.

**Semantics.**

- **A GET returns the saved snapshot.** It also recomputes the content and compares fingerprints to set `underlying_data_changed`. It never regenerates.
- **Generate** is idempotent: 201 when it created the snapshot, 200 returning the existing one otherwise. Two concurrent requests make one row.
- **Regenerate** works under a row lock, in one transaction, as the next revision. A forced failure leaves the old snapshot byte-for-byte equal and writes no audit record.
- Only closed months, within the employment, can be generated (422 `month: not_closed` / `before_joining` / `after_termination`).

**Stale-data proof** (e2e):

- A task added later for April → `underlying_data_changed: true`, while the saved `tasks.assigned` stays 4 and the revision stays 1.
- Finalizing April's payroll → the provisional snapshot is **not** rewritten (still provisional, still "draft") and is flagged.
- Changing the performance weights → March is flagged, and its stored weights stay the old ones.
- Regeneration → revision 2, today's figures (5 tasks, final salary, not provisional), flag cleared. Audited with before and after.

**Visibility.** The salary section follows the salary module, not the report grant:

- ADMIN sees it all.
- An EMPLOYEE sees their own only from a finalized period (as their payslips); otherwise `withheld: not_finalized`.
- A MANAGER never sees a team member's salary (`withheld: no_permission`, OD-07).

**Scheduled generation** (`report-jobs.ts`) is an hourly BullMQ job on the existing Redis.

- For each active company it reads the company's own calendar day. On the 1st **in that company's timezone**, it generates every applicable employee's missing snapshot for the month that just closed: not deleted, not deactivated, employed during the month.
- It is tenant-by-tenant, as the company's system actor (audited `report.snapshot_generated`, `source: scheduled`).
- It is idempotent: it fills only what is missing. It is retry-safe: the hourly runs through the 1st retry a failure.
- It never generates the current month.
- The e2e proves the timezone: at 31 March 16:00 UTC, Tokyo's company generates and Cairo's does not; at 23:00 UTC Cairo's generates 4 and Tokyo's, still on its 1st, creates 0.

**Events** (Phase 15 seam, `REPORT_EVENT_SINK`): `monthly_report_ready`, `report_export_completed`, `report_export_failed`, published after commit and after audit. The deferred sink only records that delivery is pending. **In-app notification delivery is Phase 15.**

## Permissions and scope

| Caller   | Company reports                                                                                                            | Monthly reports                                                      | Export                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ADMIN    | all eight, company scope                                                                                                   | company; generate and regenerate                                     | everything readable                                                                     |
| MANAGER  | attendance, performance, tasks, goals — **team scope, in the SQL**; payroll, inventory, warehouse, stock movements **403** | team; generate and regenerate; salary withheld                       | team scope, people reports only — **403** for the four others even with `report.export` |
| EMPLOYEE | none (403)                                                                                                                 | own only; may generate a missing month; **may not regenerate** (403) | none (403)                                                                              |

- Team scope is a `manager_id = caller` condition inside the query, never fetch-then-filter.
- Filters narrow a scope and never widen it. An employee filter outside the team is 403; a department filter is intersected with the team.
- Another company's employee, department, location, product, category or user is **404**, as a filter or as a monthly report target.
- No report ever aggregates another company's rows: company B's attendance, tasks and stock never appear for A (e2e), and RLS applies to every query.

## Export

**Synchronous** (≤ 5,000 rows): `200 text/csv; charset=utf-8`.

- UTF-8 with a BOM, for Arabic in spreadsheet software.
- RFC 4180 quoting: e.g. the department `Sales, "North"` becomes `"Sales, ""North"""`.
- Exact decimals as strings: `-30.000`, `20200.00`.
- Text cells starting with `= + - @` are prefixed with an apostrophe (formula injection). Negative numbers are left alone.
- A preamble states the company, report, scope, range, every filter by name, timezone, generation time and provisional state. Headers are in the reader's language.
- The file name is in `Content-Disposition`, and CORS now exposes it (see "Bugs found").

**Background** (more than 5,000 rows):

- A `report_exports` row is queued and the response is `202 { id, status }`. The BullMQ job (in-process when background jobs are off) builds the file and stores it in private object storage.
- The ledger is read in keyset batches of 1,000, **each batch in its own short transaction**. It is append-only and ordered by `sequence`, so the walk is a consistent view.
- The requester polls `GET /reports/exports/{id}` and downloads the file. Anyone else, including another company's ADMIN, gets 404.
- More than 250,000 rows is refused up front (422 `REPORT_EXPORT_TOO_LARGE`), so memory is bounded.

**Audit:** every successful export is `report.exported` with key, format, mode, row count, scope, range and filters, written after the work. A refused or failed export writes none.

**Failure:** the job marks the export `failed` with a reason, publishes `report_export_failed`, and the screen offers a retry with the filters unchanged.

## Rate limit

20 requests per hour per user, one allowance shared by every report read, export and monthly-report endpoint, on its own Redis key (`report:{company}:{user}`).

The e2e makes 20 reads, then:

- the 21st read is 429 `RATE_LIMITED` with `Retry-After`, and an export is also 429;
- `GET /employees` still answers, and another user still reads reports.

Export status and download are not counted: they read a finished job and do not run a report.

## Performance — `test/reports-scale.e2e.test.ts`

The data set is DOCUMENT 26's, bulk-loaded into PGlite with `generate_series`:

- 200 employees;
- 24 months of attendance (146,000 records);
- 10,000 tasks;
- 1,000 goals;
- 5,000 products;
- **200,000 stock movements**;
- 12 months of payroll.

Each report is read over its widest unconfirmed range (12 months), through the real API under `ufuq_app` and RLS:

| Report                                  | Time (PGlite)                | SQL statements per request |
| --------------------------------------- | ---------------------------- | -------------------------- |
| Attendance (73,000 records in range)    | ~1.3 s                       | 22                         |
| Tasks                                   | ~0.17 s                      | 22                         |
| Goals                                   | ~0.08 s                      | 24                         |
| Payroll                                 | ~0.07 s                      | 22                         |
| Inventory (5,000 products)              | ~0.10 s                      | 23                         |
| Warehouse                               | ~0.22 s                      | 22                         |
| Stock movements (page of 25 of 200,000) | ~0.16 s                      | 26                         |
| Performance (200 employees, one month)  | ~0.05 s                      | 29                         |
| Export, 200,000 movements (background)  | ~23 s, every row in the file | —                          |

All are under the 5-second target; PGlite is WebAssembly, slower than a real PostgreSQL. The statements per request include authentication and the tenant transaction. They are counted once Prisma's asynchronous query events have settled, excluding the engine's own `SELECT 1` connection check.

**No N+1.** For attendance, tasks, goals, payroll and performance, one employee, 20 employees and 200 employees issue the same number of statements. The whole company is exactly one fewer, because no filter name is looked up.

**Indexes added:** `stock_movements (company_id, sequence)`, `stock_movements (company_id, created_at)`, `tasks (company_id, created_at)`.

**Expected row scale per report:**

- attendance, tasks and performance rows: ≤ headcount (× months for performance);
- goals: the goals in range;
- payroll: headcount × months;
- inventory: the catalogue;
- warehouse: the locations;
- stock movements: unbounded, always paged, exported in batches.

## Web

| Route                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin/reports`                      | B17 catalogue: Financial · Attendance · Tasks & Goals · Inventory. A card only for a report the caller may read (a manager sees the four people reports).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/admin/reports/:reportKey`           | B18 viewer. The filter bar is inline on desktop and a bottom sheet on phones, and is applied explicitly so the 20/hour allowance is never spent per keystroke. Shows the report metadata (scope, range, filters, generated time, provisional), headline figures, a trend chart (bars plus a screen-reader table), breakdowns, and the paged detail table (scrolls inside its own box, first column frozen). CSV export (download, or the share sheet on touch devices; background exports polled), print. Loading / empty ("No data for the selected filters", with "last 3 months") / error / success states; a 403 says "not allowed" with no retry; a range over 12 months asks for confirmation first; filters survive errors. |
| `/app/reports`, `/app/reports/:month` | C13: the employee's own report, mobile first. Month navigation, generation time and version, provisional banner, "underlying data changed" warning, the five sections, print; "Generate" for a missing month; no regenerate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Employee profile → Monthly Reports    | B4 tab: the list of snapshots (overall, provisional) and the viewer, `?month=` in the URL; regenerate with a confirmation naming the month.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Dashboards                            | A "Reports" link on `/admin` and "My monthly report" on `/app`. No global navigation exists yet; the redesign brings it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Print stylesheet:**

- Hides navigation, filters, every button, tabs and the month list.
- Keeps the title, the company, the scope, the range, the filters, the generation time and the provisional state.
- Tables print whole, with no inner scroll and rows never split. Grids fit as many columns as the paper allows.
- Logical properties throughout, for RTL and LTR alike.

A printed viewer prints the current page of rows; the full set is the CSV.

## Browser verification

Against a temporary local stack: the real API over PGlite, seeded relative to today (August finalized and adjusted, September a draft, attendance, tasks, goals, inventory, August snapshots made by the scheduled runner with one made stale), on the **production build** (`next start`). The harness was deleted before commit.

**Overflow sweep:** the catalogue, all eight reports and the profile's Monthly Reports tab (two months), in **Arabic and English** at **375, 800 and 1280 px**. That is 66 combinations, all with **no page-level horizontal overflow**. One transient load failure was the single-connection PGlite refusing a connection mid-sweep; it loads on retry. The UI showed its error state with retry, as designed.

**Functional checks:**

- **Attendance and payroll** match the seed exactly in the browser (September: Omar 22 / 21 / 19 office / 2 WFH / 1 late / 1 absent; payroll provisional with the reason, August adjusted net 20,200.00, month-over-month −470.64).
- **CSV export from the button** (download intercepted, nothing saved): BOM present, file name `ufuq-stock-movements-2026-10-01_2026-10-31.csv`, exact signed decimals, the Arabic preamble.
- **Print**, simulated by applying the page's own print rules: controls gone, metadata kept, tables unscrolled.
- **Monthly report (admin):**
  - August shows "underlying data changed".
  - Regenerate with confirmation gives version 2 and the warning clears.
  - September "Generate" gives a provisional report whose figures match the attendance and payroll reports.
- **Employee:**
  - `/app/reports` opens last month.
  - Salary is withheld for the draft month and shown for the final one.
  - The employee can generate a missing month but is never offered Regenerate.
- **Manager:**
  - The catalogue has 4 cards; attendance is "My team only" with the note, showing Sara and Omar only.
  - Payroll is refused with "not allowed".
  - A team member's monthly report hides salary.
- **Phone:** the filter sheet opens at the bottom; a 21-month range asks for confirmation, then runs.

## Bugs found and fixed

1. **Report query plans at DOCUMENT 26 volume** (found by the scale test).
   - What happened: attendance over 12 months and inventory over 5,000 products took more than 5 seconds and hit the transaction timeout; tasks took 2.9 s. CTEs referenced twice were materialized without statistics.
   - Fix: attendance and tasks now aggregate once with `GROUPING SETS` and a semi-join on the scope; inventory CTEs are `MATERIALIZED`.
   - Result: 1.3 s, 0.17 s and 0.10 s respectively.
2. **A large background export ran in one transaction** and would always expire. Fix: one short transaction per keyset batch; 200,000 rows now export.
3. **`overall_score` was rendered `'100'`** instead of `'100.00'` (Prisma drops trailing zeros). Fix: rendered at the column's exact scale.
4. **CORS did not expose `Content-Disposition`**, so the browser lost the export's file name (browser check). Fix: `cors.ts` exposes `Content-Disposition`, `X-Report-Rows` and `Retry-After`, with a unit test.
5. **The chart's screen-reader table pushed the RTL phone page 258 px sideways** (browser check). Cause: the global `table { min-inline-size: 600px }`. Fix: `.visually-hidden` overrides it.
6. **A 403 was shown as "could not load — try again"** (browser check). Fix: the viewer and the monthly report say "not allowed", with no retry.
7. **The profile's month list did not refresh after generating** (browser check). Fixed.
8. **The print grid forced three columns** and cramped narrow pages (browser check). Fix: auto-fit.
9. **The N+1 test's statement counter was racy** (found by the final full gate, where it failed once under load and passed alone).
   - What happened: Prisma emits query events asynchronously, so a trailing event of one request could be counted against the next; and the engine's `SELECT 1` liveness check on an idle pooled connection was counted as a request statement.
   - Fix (test only): the counter waits for the event stream to settle before resetting and before reading, and ignores the bare `SELECT 1`. No application code changed; the reports issue the same statements for 1, 20 and 200 employees, deterministically.
   - The settled count corrected the stock-movement report's figure from 24 to 26 statements (the earlier count had lost trailing events).

## Deviations and interpretations (documented in code)

- Attendance is **record-based**: a day not yet recorded is not counted, and a historical status is never recomputed.
- Inventory has no date range (the stock as it stands); the warehouse report's value is likewise the stock now, its movement volume is in the range.
- Overdue in a snapshot is judged when it is generated. For a closed month this is stable: every deadline in it is already past.
- A month with no payroll has no payroll rows; its snapshot salary is `source: "none"`, provisional.
- Excel and PDF export were not built (SHOULD / NICE TO HAVE).
- The web audit-log viewer's action catalogue was not extended. It has not been since Phase 11; the new actions are stored and filterable through the API.

## Schema — migration `20261016000000_phase12_reports`

- `audit_action` gains `report.exported`, `report.snapshot_generated` and `report.snapshot_regenerated`.
- New tables:
  - `monthly_employee_reports`: RLS, same-company triggers, unique `(employee_id, year, month)`, regeneration-only UPDATE guard, no DELETE;
  - `report_exports`: RLS, same-company trigger, status CHECKs, no DELETE.
- Indexes: `stock_movements (company_id, sequence)`, `(company_id, created_at)`, `tasks (company_id, created_at)`.
- `AttachmentsModule` now also exports `OBJECT_STORAGE`, so background exports use the same private store.

## Verification results

The complete gate was run from scratch after the last change, every turbo task forced (0 cached).

| Check                         | Result                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `prettier --check .`          | Pass — all files formatted                                                                        |
| `turbo run lint --force`      | Pass — 9/9 tasks, 0 errors (4 pre-existing `no-console` warnings in `packages/db/prisma/seed.ts`) |
| `turbo run typecheck --force` | Pass — 15/15 tasks                                                                                |
| `turbo run test --force`      | Pass — 15/15 tasks, **1,722 tests**, 0 failed                                                     |
| `turbo run build --force`     | Pass — 15/15 tasks                                                                                |

| Package        | Test files | Tests     | Phase 12 additions                                                         |
| -------------- | ---------- | --------- | -------------------------------------------------------------------------- |
| `@ufuq/api`    | 36         | 1,016     | 99: `reports.e2e` 61, `reports-scale.e2e` 16, `reports-rules` 20, `cors` 2 |
| `@ufuq/db`     | 16         | 323       | 11: `phase12-rls`                                                          |
| `@ufuq/web`    | 19         | 270       | 14: `lib/reports`                                                          |
| `@ufuq/auth`   | 5          | 44        | —                                                                          |
| `@ufuq/money`  | 1          | 25        | —                                                                          |
| `@ufuq/config` | 1          | 20        | —                                                                          |
| `@ufuq/i18n`   | 1          | 20        | —                                                                          |
| `@ufuq/mobile` | 1          | 4         | —                                                                          |
| **Total**      | **80**     | **1,722** | **124**                                                                    |

## Accepted limitations

- Excel and PDF export are not built (DOCUMENT 18: SHOULD / NICE TO HAVE); CSV is the V1 export.
- In-app delivery of `monthly_report_ready` and the export events waits for Phase 15; the events are published to the deferred sink.
- A printed report prints the current page of rows; the full set is the CSV export.
- The web audit-log viewer's action catalogue does not list the three new report actions; they are stored and filterable through the API.
- Scale timings were measured on PGlite (WebAssembly), not a production PostgreSQL.
