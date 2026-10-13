# DOCUMENT 25 — DEVELOPMENT ROADMAP

Phases are ordered by **technical dependency**, not by perceived importance. Building attendance before the schedule engine, or payroll before attendance, produces rework.

Each phase has an exit criterion. A phase is not done until its criterion is met, and the next phase does not start early.

---

## PHASE 1 — Project foundation
Repository, environments, CI, linting and formatting, database connection, migration tooling, error handling, logging, localisation infrastructure (Arabic and English resources, `dir` handling), base layout shell, health check.

**Exit:** an empty application boots in all environments, switches language and direction, and CI passes.

## PHASE 2 — Design system
Every token from DOCUMENT 10 as code. Every component in §6: buttons, inputs, cards, tables, badges, modals, dropdowns, navigation, charts, progress, toasts, alerts, empty states, skeletons. Component gallery for review. RTL verified per component.

**Exit:** the gallery renders every component in both directions at every breakpoint, and no later phase needs to invent a new base component.

> Building this before feature work is what prevents twelve slightly different button styles.

## PHASE 3 — Authentication
Users, roles, permissions, role_permissions tables. Login, logout, password reset, invitation acceptance. Session management. Rate limiting and lockout. Authorization middleware with permission and scope resolution. The tenant global query scope.

**Exit:** the authorization matrix test passes for every implemented endpoint, and the tenancy scope cannot be bypassed by omitting a `where` clause.

## PHASE 4 — Company structure
Companies, departments, positions, work schedules, work schedule days, holidays. Company settings screens. Company registration flow.

**Exit:** a company can be created and fully configured, including a working schedule that is not hardcoded anywhere.

## PHASE 5 — Employees
Employees table and relationships. CRUD, activation, deactivation. Profile with all tabs (tabs may be empty pending later phases). Invitation flow. Manager assignment with cycle prevention.

**Exit:** employees can be created, invited, and manage their own login; the last-admin guard works.

## PHASE 6 — Attendance
Attendance records, check-in and check-out with work mode, calculation engine (hours, lateness, overtime, half day), all statuses, admin daily board and monthly matrix, employee history, correction requests and approval, nightly absence job, holiday and weekend generation.

**Exit:** a full month of attendance can be recorded and reviewed, with every status reachable and every calculation matching the schedule configuration.

> This is the highest-value phase. Everything downstream depends on it being right.

## PHASE 7 — Tasks
Tasks, checklist items, progress updates. Admin table and board views. Employee list and detail. Progress calculation. Status transition validation. Overdue derivation.

**Exit:** progress calculation is correct in every checklist scenario, and invalid status transitions are rejected server-side.

## PHASE 8 — Goals
Goals and goal progress. Three types. Manual progress for sales and custom. Automatic derivation for task goals. Milestone detection. Performance configuration and calculation.

**Exit:** performance scores are computed entirely from configuration, with no weight or coefficient present in code.

## PHASE 9 — Requests
The unified requests centre, categories, approval workflow, admin inbox, employee submission and history.

**Exit:** Attendance, Salary, Task and General requests can each be submitted, reviewed, approved, rejected, and cancelled, with reasons enforced. The Leave category exists in the unified centre as an integration boundary (OD-09 hybrid model: the inbox row indexes a specialised `leave_requests` record); Leave's specialised lifecycle is completed in Phase 10.

> Roadmap clarification, approved during Phase 9: a leave request depends on leave types, balances and pending holds (DOCUMENT 16), which are Phase 10. Phase 9 therefore does not build a generic Leave submission; it leaves the category and the indexing boundary in place for Phase 10.

## PHASE 10 — Leave
Leave types, balances with pending holds, requests, approval creating attendance records, carry-over job, balance adjustment. Leave requests are indexed into the unified Requests Centre exactly as attendance corrections are, and the centre's approve / reject / cancel delegate to the leave logic.

**Exit:** approving leave produces correct attendance records and correct balances, and all the conflict cases in DOCUMENT 16 are blocked. Leave participates fully in the unified Requests Centre: a leave request can be submitted, reviewed, approved, rejected, and cancelled there, with reasons enforced — completing the Phase 9 exit criterion for the Leave category.

> Placed after both Attendance and Requests because it depends on both.

## PHASE 11 — Payroll
Salary policies, employee salary history, payroll periods and lines, generation from attendance, deductions and bonuses, the full state machine, finalization with snapshot and lock, adjustments, employee salary views.

**Exit:** a payroll can be generated, reviewed, finalized, and paid; a finalized line cannot be modified through any path; and the adjustment flow works.

> The highest-risk phase. It gets the most test coverage in DOCUMENT 26.

## PHASE 12 — Reports
All company and employee reports. Monthly report snapshot generation. Filters. CSV export. Print stylesheet.

**Exit:** every report in DOCUMENT 18 returns correct figures that reconcile with the source modules.

## PHASE 13 — Warehouse
Warehouses with all types, warehouse dashboard, per-location stock, transfers as paired transactional movements.

**Exit:** a transfer either completes fully or not at all, proven by a forced-failure test.

## PHASE 14 — Inventory
Products, categories, suppliers, all movement types, valuation, low and out of stock detection, movement history, reconciliation job.

**Exit:** `product_stock` can be rebuilt from `stock_movements` and matches exactly, and there is no path in the system that writes a quantity directly.

## PHASE 15 — Notifications
Notification infrastructure, all event types, recipient resolution, deduplication and grouping, notification centre, unread counts.

**Exit:** every event in DOCUMENT 19 produces a notification for the correct recipients and no one else.

## PHASE 16 — Public website
All nine pages, registration flow, SEO, performance budget.

**Exit:** the site is complete, fast, accessible, and correct in both languages.

## PHASE 17 — Testing & hardening
Complete the test suites in DOCUMENT 26. Security testing per DOCUMENT 20 §12. Performance testing with realistic data volumes. Accessibility audit. RTL audit across every screen. Bug fixing.

**Exit:** all suites pass, no high-severity security findings remain, and the accessibility and RTL audits are clean.

## PHASE 18 — Deployment
Production infrastructure, backups with a **tested** restore, monitoring and alerting, error tracking, deployment pipeline, rollback procedure, runbook, incident response procedure.

**Exit:** a restore has actually been performed from a backup, and a rollback has actually been executed.

---

## DEPENDENCY MAP

```
1 Foundation
 └─ 2 Design system
     └─ 3 Authentication
         └─ 4 Company structure
             └─ 5 Employees
                 ├─ 6 Attendance ──┬─ 10 Leave ──┐
                 │                  └─ 11 Payroll ─┤
                 ├─ 7 Tasks ────────┬─ 8 Goals ────┤
                 ├─ 9 Requests ─────┴──────────────┤
                 └─ 13 Warehouse ── 14 Inventory ──┤
                                                    └─ 12 Reports
                                                        └─ 15 Notifications
                                                            └─ 16 Website
                                                                └─ 17 Testing
                                                                    └─ 18 Deployment
```

Notifications come late deliberately: the events they respond to must exist first. Reports come after the modules that produce their data.

### Execution order after Phase 11 (documented under rule 4, before Phase 13 began)

The phases keep their numbers and their scope. They are **executed** in the order the dependency map above already draws: **Phase 13 Warehouse → Phase 14 Inventory → Phase 12 Reports**.

Why: DOCUMENT 18's V1 company reports include inventory, warehouse and stock movements, and Phase 12's exit criterion is that every report "returns correct figures that reconcile with the source modules". Those sources are built by Phases 13 and 14. Building Reports first would mean either shipping those reports without data to reconcile against, or building them twice. The textual order (12 before 13) is a numbering order; the dependency map is the build order.

## RULES

1. **Do not skip phases.** Phase 2 before feature work is what keeps the UI coherent.
2. **Do not start a phase before its dependencies pass their exit criteria.**
3. **Each phase ends with its own tests written**, not deferred to Phase 17. Phase 17 is for cross-cutting hardening, not for writing the unit tests that should have accompanied each feature.
4. **Reordering is permitted** where a genuine technical dependency argues for it — but the reasoning must be documented before the change, per RULE 1 of DOCUMENT 27.
5. **No phase is "done" until** it satisfies its specification document and the definition of done in DOCUMENT 24.
