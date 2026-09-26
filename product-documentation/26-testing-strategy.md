# DOCUMENT 26 — TESTING STRATEGY

## PRINCIPLE
Test what breaks money, permissions, and data integrity hardest. In this system that means payroll, attendance, tenancy, and stock — in that order.

Coverage percentage is not the target. Coverage of the invariants in DOCUMENT 07 §9 is.

---

## 1. Unit testing

**Highest priority — the calculation engines:**

| Area | Cases |
|---|---|
| Daily wage | All three basis options; months of 28, 29, 30, 31 days; joining and termination mid-month |
| Attendance adjustment | Absence, unpaid leave, lateness tiers, overtime, and all combinations |
| Net salary | Base + adjustment − deductions + bonuses, with rounding applied once at the end |
| Working days | Every schedule shape, holidays, employee joining and leaving mid-period |
| Working hours | Normal, overtime, half day, missing check-out, overnight |
| Lateness | Inside grace, at the boundary, outside grace |
| Task progress | 0 items, 1 item, all complete, none complete, items added and removed after completion |
| Goal progress | Under, at, and over target; zero target rejected; percentage-unit goals |
| Performance score | Every weight configuration; missing components renormalised, not zeroed |
| Leave duration | Weekends, holidays, month boundaries, year boundaries, all-weekend range |
| Leave balance | Pending holds, approval, rejection, cancellation, carry-over with and without cap |
| Stock balance | Every movement type; sequence replay must equal the cached quantity |
| Weighted average cost | Multiple purchases at different costs, then outbound movements |

Every monetary test asserts on exact decimal values. A test that passes with floating-point tolerance is testing the wrong thing.

**Also unit tested:** validation rules, status transition matrices, permission scope resolution, date and timezone helpers, and locale formatting.

## 2. Integration testing

| Flow | Assertions |
|---|---|
| Employee creation | User, employee, leave balances, and salary record all created; failure rolls back all four |
| Leave approval | Balance deducted, hold released, attendance records created, request updated — all or nothing |
| Attendance correction approval | Record updated and request closed atomically |
| Payroll generation | All lines created; a mid-run failure creates none |
| Payroll finalization | Snapshot written, lines locked, period state changed |
| Deduction | Line net recalculated correctly |
| Stock movement | Movement inserted and cache updated in one transaction |
| Stock transfer | Two paired movements with one `transfer_group_id`; forced failure leaves neither |
| Monthly report generation | Figures reconcile with attendance, tasks, goals, and payroll |

**Forced-failure tests are mandatory** for every transactional flow: inject a failure after the first write and assert nothing persisted.

## 3. API testing

For every endpoint: success case · validation failure with field-level errors · unauthenticated (401) · unauthorised role (403) · out-of-scope record (403) · cross-tenant record (**404**) · not found (404) · business conflict (409) · pagination boundaries · sort whitelist rejection of unknown fields · unknown request fields rejected.

Idempotency: repeat a financial or inventory POST with the same `Idempotency-Key` and assert one record, one result.

## 4. Permission testing

**A full matrix: every endpoint × every role × every scope.** Generated from the permission catalogue in DOCUMENT 02 so it cannot drift from the specification.

Specific assertions:
- MANAGER cannot read another department's data.
- EMPLOYEE cannot read another employee's salary, tasks, attendance, or requests.
- EMPLOYEE cannot create, delete, or reassign tasks.
- EMPLOYEE cannot update their own goal progress.
- MANAGER cannot access payroll.
- MANAGER cannot access warehouse or inventory.
- No role can modify a finalized payroll line.
- No role can update or delete a stock movement.
- No role can update or delete an audit log.
- The last active ADMIN cannot be deactivated or demoted.

## 5. Tenancy testing — highest severity

For **every** endpoint that accepts an id, call it with a valid id belonging to a different company and assert **404**.

Additionally:
- List endpoints never return another company's rows, under any filter or sort combination.
- Reports and exports never aggregate across companies.
- Attachment URLs from company A return 404 for company B.
- Background jobs process only their own company's data.
- Cache keys do not collide across companies.

This suite runs on every commit. A failure here blocks the build.

## 6. Payroll testing — highest risk

Beyond the unit and integration cases:
- Finalized lines reject UPDATE through the service layer, the API, and (where supported) the database.
- Adjustments never modify the original line.
- Regeneration is refused in every state except Draft.
- Concurrent generation attempts produce one period, not two.
- Concurrent finalization produces one finalization, the second returning 409.
- Attendance changes covering a finalized period are refused.
- A salary change mid-period is applied correctly across the split.
- Net salary cannot go below zero.
- Every deduction and bonus carries a reason and a creator.
- Total figures on the period equal the sum of its lines, exactly.

## 7. Attendance testing
Duplicate check-in returns 409 and creates no second record · check-out without check-in is refused · timezone correctness across DST-free and DST-affected zones · schedule change mid-month evaluates each day against the schedule in effect then · retroactive holiday requires confirmation and does not silently rewrite · the nightly absence job is idempotent when run twice · leave-generated records link back to the request.

## 8. Inventory testing
Negative stock is blocked when disabled and warned when enabled · concurrent movements on one product serialise correctly under row locking · transfers are atomic · the reconciliation job's rebuild from movements matches the cache exactly for a large generated dataset · movements reject UPDATE and DELETE at every layer · weighted average cost is correct across interleaved inbound and outbound movements.

## 9. UI testing
Every screen implements all four states — asserted, not assumed · forms preserve input on validation failure · destructive confirmations appear and can be cancelled · optimistic checklist updates roll back on failure · pagination, filters, and sorting persist in the URL · unsaved-changes warnings fire.

## 10. Responsive testing
The fourteen-combination matrix from DOCUMENT 22 §Testing matrix, on every screen: seven device classes × two directions. Assertions: no horizontal page scroll · touch targets ≥ 44px · navigation transforms correctly · tables become cards below 1024px · payroll finalization is unavailable on mobile.

## 11. RTL testing
Every screen in Arabic: sidebar on the right · tables and progress fill right to left · directional icons mirrored, non-directional not · numbers, SKUs, and emails render LTR inside RTL text without bidirectional corruption · date pickers open on the correct side · drawers slide from the correct edge · no layout uses physical left/right properties.

RTL is not verified on the login page alone. It is verified on every screen.

## 12. Security testing
Per DOCUMENT 20 §12: authorization matrix · tenancy isolation · SQL injection · XSS · path traversal · file upload abuse (wrong type, magic-byte mismatch, oversized, malicious name, direct URL access) · rate limits · session expiry, revocation, and fixation · sensitive data absent from every response shape and every log line · third-party penetration test before launch.

## 13. Performance testing
Realistic volumes: 200 employees, 24 months of attendance, 10,000 tasks, 5,000 products, 200,000 stock movements.

Targets: list endpoints under 500ms p95 · dashboard under 2s · payroll generation for 200 employees under 30s · reports under 5s or converted to a background job · no N+1 queries on any list or detail endpoint (asserted by query-count tests).

## 14. Accessibility testing
Automated axe scan on every screen · manual keyboard traversal of every flow · screen reader pass on the critical flows (login, check-in, task completion, leave request) · contrast verification against the design tokens · focus management in modals and drawers.

## 15. Edge cases
Every edge case table in DOCUMENTS 12–17 is a test case. They are written from the specification, not discovered in production.

## 16. Regression
Every fixed bug gets a test that fails before the fix and passes after. No exceptions — this is how an ERP stays correct over years.

## 17. Test data
A seeded dataset covering: a company with a full year of history · employees who joined and left mid-month · every attendance status · every leave scenario · tasks in every state · goals of every type · payroll periods in every state · products across multiple locations with long movement histories. Reproducible from a single command.

## 18. Definition of done
A feature is done when: unit tests cover its calculations · integration tests cover its transactions · API tests cover its endpoints across roles · permission and tenancy tests pass · all four UI states are tested · responsive and RTL verified · edge cases from its specification are covered · no new N+1 queries · and audit records are asserted where DOCUMENT 21 requires them.

Anything less is not done, regardless of how well it demos.
