# DOCUMENT 24 — MVP SCOPE

> Scope creep is the primary risk to this project. This document is the boundary. Anything not listed as MUST HAVE or SHOULD HAVE is out of V1, regardless of how small it seems in the moment.

## MUST HAVE — V1 does not ship without these

### Foundation
- Multi-company database architecture with enforced isolation
- Authentication: login, logout, password reset, invitation acceptance
- Role-based authorization enforced server-side
- Arabic RTL interface with English support
- Design system implementation per DOCUMENT 10
- Responsive layouts per DOCUMENT 22
- All four screen states everywhere: loading, empty, error, success
- Audit logging for all actions listed in DOCUMENT 21

### Company & employees
- Company profile and settings
- Departments and positions
- Employee CRUD, activation and deactivation
- Employee profile with all seven tabs
- Manager assignment
- Employee invitation flow

### Attendance
- Check-in and check-out with OFFICE / WFH mode
- Configurable working schedules and holidays
- Automatic calculation of hours, lateness, and overtime
- All attendance statuses
- Daily board and monthly matrix for admin
- Employee history
- Attendance correction requests with approval
- Nightly absence-marking job

### Leave
- Configurable leave types and per-employee allowances
- Balance tracking with pending holds
- Leave request, approval, and rejection
- Automatic attendance record creation on approval

### Tasks
- Task CRUD with all fields and statuses
- Checklists with automatic progress calculation
- Progress updates with history
- Table and board views for admin
- Employee task list and detail with checklist interaction

### Goals & performance
- Three goal types with progress tracking
- Append-only progress history
- Configurable performance weights
- Performance calculation feeding monthly reports

### Requests
- Unified requests centre across five categories
- Approval workflow with reasons and responses

### Payroll
- Configurable salary policy
- Salary history per employee
- Monthly payroll generation from attendance
- Deductions and bonuses with reasons
- Full state machine through to Paid
- Immutable finalized payroll with adjustment records
- Employee salary view and payslip history

### Warehouse & inventory
- Multiple warehouse locations including online type
- Product catalogue with categories and suppliers
- Per-location stock derived from movements
- All movement types
- Transfers as paired transactional movements
- Low-stock and out-of-stock detection
- Warehouse dashboard and inventory valuation

### Reporting
- All eight company reports and five employee reports listed in DOCUMENT 18
- Monthly report snapshot generation
- Date, department, and employee filtering
- CSV export
- Print stylesheet

### Notifications
- In-app notifications for all events in DOCUMENT 19
- Notification centre with read state

### Dashboards
- Admin dashboard with the eleven specified sections
- Employee dashboard prioritising the attendance action

### Public website
- All nine pages per DOCUMENT 23
- Company registration flow

## SHOULD HAVE — included if the schedule allows, cut without drama if not

- Excel export in addition to CSV
- Compact table density preference
- Bulk employee actions (activate, deactivate, export)
- Attendance monthly matrix export
- Task board drag-and-drop between status columns
- Notification grouping and summarisation
- Onboarding checklist for new companies
- Employee photo upload with cropping
- Advanced report filters beyond date, department, and employee
- Company logo on printed reports

## NICE TO HAVE — only after everything above is complete and stable

- PDF export
- Dashboard widget reordering
- Saved report filter presets
- Dark mode
- Keyboard shortcuts for power users
- Global search across modules
- Employee directory with org chart view
- In-app product tour
- Task comments

## FUTURE — explicitly V2 or later. Not in V1 under any argument.

### Product
Individual edition · CRM · accounting ledger · procurement · manufacturing · advanced HR (recruitment, appraisal cycles, org planning) · tax and social insurance calculation · end-of-service settlement · loans and advances

### Capability
Multi-currency · multiple pay cycles · biometric or geofenced attendance · shift patterns and rosters · half-day and hourly leave · subtasks and dependencies · recurring tasks · time tracking · barcode scanning · purchase and sales orders · batch, lot, and serial tracking · FIFO/LIFO valuation · stock-take sessions

### Platform
Mobile native applications · email and push notifications · SSO and SAML · two-factor authentication · public API for integrations · webhooks · third-party integrations · AI features of any kind · data warehouse export · white-labelling

## SCOPE CONTROL RULES

1. A request that is not in MUST HAVE or SHOULD HAVE is answered with "that is in the FUTURE list" and a note of who asked and when.
2. Moving an item from FUTURE into V1 requires an explicit written decision from the product owner, recorded in OPEN DECISIONS, and an accompanying decision about what leaves V1 to make room.
3. "It's only a small change" is not a reason. Small changes to an ERP's financial and inventory modules are how integrity bugs enter.
4. A module is done when it satisfies its specification document, not when it demos well.
5. The definition of done for every V1 feature: implemented · permission-checked server-side · all four states handled · tested per DOCUMENT 26 · works in RTL and LTR · works at every breakpoint in DOCUMENT 22 · audited where DOCUMENT 21 requires it.

## SUCCESS CRITERIA FOR V1

V1 is successful when one real company can:
1. Set up their structure, schedule, and employees without assistance.
2. Record a full month of attendance including office and remote days.
3. Assign and complete tasks with checklists.
4. Process leave requests end to end.
5. Generate, review, and finalize a correct payroll for that month.
6. Track stock across at least two locations with an accurate movement history.
7. Read a monthly report that they trust.

If a company can do all seven without a support call, V1 has done its job.
