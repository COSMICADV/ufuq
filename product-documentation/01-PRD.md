# DOCUMENT 01 — PRODUCT REQUIREMENTS DOCUMENT

## 1. Product identity

| Field | Value |
|---|---|
| Arabic name | أُفق |
| Latin name | Ufuq |
| Meaning | "Horizon" |
| Category | ERP (Enterprise Resource Planning) |
| Primary market | Arabic-speaking SMEs, initially Egypt |
| Default language | Arabic (RTL) |
| Secondary language | English (LTR) |
| Default currency | EGP |
| V1 target | Company edition |
| Later | Individual edition |

## 2. Product vision

أُفق brings company management and employee operations into one connected system.

Most SMEs in this market run their operations across three or four disconnected tools: a spreadsheet for attendance, a chat group for tasks, a second spreadsheet for salaries, and a third for stock. The data never reconciles, and the month-end close is manual reconstruction.

أُفق replaces that with a single connected chain:

```
Working schedule → Attendance → Working days → Payroll → Monthly report
Tasks + Checklists → Progress → Performance → Monthly report
Goals → Progress → Performance → Monthly report
Products → Stock movements → Warehouse valuation → Inventory report
```

Every module writes into the same audit trail and the same reporting layer.

### What أُفق is
A serious ERP for company operations: people, time, work, money, and stock.

### What أُفق is not
A task-management app with extra screens. Task management is one module among eleven, and it exists mainly because it feeds performance and monthly reporting.

## 3. Core users

| User | Description | Primary need |
|---|---|---|
| SUPER ADMIN | Platform-level operator (أُفق itself) | Manage companies, subscriptions, platform health |
| ADMIN | Company owner or operations lead | Full visibility and control of one company |
| MANAGER | Department head | Manage their team's tasks, goals, attendance, requests |
| EMPLOYEE | Staff member | Record attendance, complete tasks, submit requests, view own salary |

Future roles (architecture must accommodate, V1 must not implement): HR, ACCOUNTANT, WAREHOUSE MANAGER, SUPERVISOR.

## 4. Functional requirements

### FR-01 Authentication & accounts
- FR-01.1 Email + password login, per company.
- FR-01.2 Password reset by email token.
- FR-01.3 Session management with logout and session expiry.
- FR-01.4 Account activation / deactivation by Admin.
- FR-01.5 Employee onboarding invitation flow.
- FR-01.6 Role assignment at user level, scoped to one company.

### FR-02 Company structure
- FR-02.1 Company profile: name, logo, timezone, currency, locale, fiscal settings.
- FR-02.2 Departments (flat list in V1, tree-capable schema).
- FR-02.3 Positions / job titles.
- FR-02.4 Manager assignment (employee → manager).
- FR-02.5 Multi-company data isolation enforced server-side.

### FR-03 Employee management
- FR-03.1 Create, edit, view, activate, deactivate employees.
- FR-03.2 Assign department, position, manager.
- FR-03.3 Set salary, working schedule, leave allowance.
- FR-03.4 Assign goals and tasks.
- FR-03.5 View attendance, performance, salary history, monthly reports.
- FR-03.6 Employee profile tabs: Overview, Attendance, Tasks, Goals, Salary, Requests, Monthly Reports.

### FR-04 Attendance
- FR-04.1 Employee check-in and check-out.
- FR-04.2 Work-mode selection: OFFICE or WFH, recorded per attendance record.
- FR-04.3 Automatic calculation of working hours, late status, overtime.
- FR-04.4 Attendance states: Present, Absent, Late, WFH, Office, On Leave, Half Day, Holiday, Weekend, Pending.
- FR-04.5 Configurable working schedule per company (and per employee override).
- FR-04.6 Attendance history: daily, monthly.
- FR-04.7 Attendance correction requests with Admin approval.
- FR-04.8 Every administrative attendance change writes an audit record.

### FR-05 Leave management
- FR-05.1 Configurable leave types and allowances.
- FR-05.2 Per-employee leave balance: total, used, remaining.
- FR-05.3 Leave request with type, dates, calculated duration, reason, optional attachment.
- FR-05.4 Approve / reject / review workflow.
- FR-05.5 Balance updates only on approval.
- FR-05.6 Approved leave writes matching attendance records.

### FR-06 Tasks
- FR-06.1 Task creation by Admin or Manager, assigned to an employee.
- FR-06.2 Fields: name, description, assignee, department, priority, start date, deadline, goal association, checklist, attachments, status.
- FR-06.3 Statuses: Not Started, In Progress, Completed, Overdue, Cancelled, On Hold.
- FR-06.4 Priorities: Low, Medium, High, Urgent.
- FR-06.5 Checklist items with automatic progress calculation.
- FR-06.6 Employee progress updates (text notes) with visible history.
- FR-06.7 Management views for completed, in-progress, overdue, and approaching-deadline tasks.

### FR-07 Goals
- FR-07.1 Goal types: Sales, Task, Custom — extensible.
- FR-07.2 Target value, current value, calculated progress.
- FR-07.3 Goal period (start / end).
- FR-07.4 Goal progress history.
- FR-07.5 Task-type goals derive current value from completed linked tasks.

### FR-08 Requests centre
- FR-08.1 Categories: Attendance, Leave, Salary, Task, General.
- FR-08.2 Fields: employee, type, description, date, status, created at, reviewed by, reviewed at, admin response, attachments.
- FR-08.3 Statuses: Pending, Approved, Rejected, Cancelled.
- FR-08.4 Unified inbox for Admin/Manager.

### FR-09 Salary & payroll
- FR-09.1 Per-employee monthly salary and derived daily wage.
- FR-09.2 Configurable salary calculation policy per company.
- FR-09.3 Monthly payroll generation from attendance.
- FR-09.4 Deductions and bonuses with amount, reason, created by, created date.
- FR-09.5 Payroll states: Draft, Under Review, Approved, Finalized, Paid, Adjusted.
- FR-09.6 Finalized payroll is immutable; corrections create adjustment records.
- FR-09.7 Employee sees only their own salary data.

### FR-10 Monthly employee reports
- FR-10.1 Per employee, per month: attendance summary, task summary, goal summary, salary summary, performance summary.
- FR-10.2 Performance calculation is configurable and documented, never hardcoded.

### FR-11 Warehouse & inventory
- FR-11.1 Multiple warehouses/locations per company, including online channels.
- FR-11.2 Product catalogue: name, SKU, category, unit, min stock, cost, selling price, supplier, status, image, description.
- FR-11.3 Stock held per product per location.
- FR-11.4 Stock movement types: Purchase, Sale, Transfer, Adjustment, Return, Damage, Manual Addition, Manual Removal.
- FR-11.5 Quantity is derived from movements; never overwritten directly.
- FR-11.6 Low-stock and out-of-stock detection.
- FR-11.7 Inventory valuation.

### FR-12 Notifications
- FR-12.1 In-app notifications for admin and employee events (see DOCUMENT 19).
- FR-12.2 Read / unread state and notification centre.
- FR-12.3 Channel architecture ready for email and push; only in-app implemented in V1.

### FR-13 Reporting
- FR-13.1 Company reports: attendance, performance, tasks, goals, payroll, inventory, warehouse, stock movements.
- FR-13.2 Employee reports: monthly attendance, tasks, goals, salary, performance.
- FR-13.3 Date, employee, and department filtering.
- FR-13.4 Export and print (see DOCUMENT 24 for V1 scope).

### FR-14 Search, filter, sort
- FR-14.1 Server-side pagination on every list.
- FR-14.2 Documented filter and sort sets per module (DOCUMENT 08).
- FR-14.3 Global search documented as architecture; not required in V1.

### FR-15 Files & attachments
- FR-15.1 Upload with type and size validation.
- FR-15.2 Private storage with authorization-checked access.
- FR-15.3 Non-guessable object keys.
- FR-15.4 Deletion and audit trail.

### FR-16 Audit logging
- FR-16.1 Audit records for all material ERP actions (DOCUMENT 21).
- FR-16.2 Audit records are append-only.

### FR-17 Settings
- FR-17.1 Company profile, working schedule, leave types, salary policy, performance weights, roles, warehouses, notification preferences.

### FR-18 Public website
- FR-18.1 Marketing site: Home, About, Features, For Companies, For Individuals, Pricing, Contact, Login, Register.

## 5. Non-functional requirements

### NFR-01 Localization
- Arabic-first, RTL default. English supported from day one.
- No hardcoded UI strings anywhere. All copy from translation resources.
- Numerals, dates, and currency formatted per locale.

### NFR-02 Performance
- List endpoints paginated, default 20, maximum 100 per page.
- Dashboard first meaningful paint under 2s on a typical office connection.
- No endpoint returns unbounded collections.
- Aggregations that scan a full month use pre-computed summaries where measured to be slow.

### NFR-03 Security
- All authorization server-side. Frontend permission checks are cosmetic only.
- Company scope enforced at the data-access layer, not per-controller.
- See DOCUMENT 20.

### NFR-04 Financial integrity
- Monetary values stored as fixed-precision decimals, never floats.
- Multi-record financial and inventory operations run inside transactions.
- Finalized payroll and historical stock movements are immutable.

### NFR-05 Auditability
- Every material action attributable to a user, a timestamp, and a before/after state where applicable.

### NFR-06 Availability & data safety
- Daily automated backups with a documented restore procedure.
- Soft delete for business entities; hard delete only via an explicit, audited administrative process.

### NFR-07 Accessibility
- Minimum 4.5:1 contrast for body text.
- Full keyboard navigation on all interactive controls.
- Visible focus states.
- Semantic markup and correct `dir` attribute.

### NFR-08 Responsiveness
- Employee-facing functionality must be excellent on mobile.
- Admin dashboard may prioritise desktop but must remain usable on tablet.

### NFR-09 Maintainability
- Business rules centralised in a service layer, never duplicated in controllers or components.
- Configuration over hardcoding for schedules, salary policy, performance weights, leave rules.

### NFR-10 Extensibility
- Multi-company from the first schema.
- Role and permission model additive without migration of existing roles.
- Goal types, leave types, movement types, and notification types extensible via data, not code branches.

## 6. Assumptions

| ID | Assumption | Risk if wrong |
|---|---|---|
| A-01 | One user account belongs to exactly one company in V1 | Multi-company users require a membership join table |
| A-02 | Currency is single-currency per company in V1 | Multi-currency requires FX rate tables throughout payroll and inventory |
| A-03 | Attendance is self-reported; no biometric or geofence integration in V1 | Trust model changes; geofencing needs location capture and privacy handling |
| A-04 | Payroll is calculated monthly, not weekly or biweekly | Period model must become configurable |
| A-05 | Inventory valuation method is weighted average | FIFO/LIFO require lot-level tracking |

All five are listed in OPEN DECISIONS.

## 7. Out of scope for V1

CRM · accounting ledger · procurement · manufacturing · advanced HR (recruitment, appraisals, org-chart planning) · tax management · AI features · third-party integrations · multi-currency · biometric attendance · e-commerce storefront.

These are future modules. Adding any of them to V1 is scope creep and must be rejected.
