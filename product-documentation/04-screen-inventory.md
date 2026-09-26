# DOCUMENT 04 — COMPLETE SCREEN INVENTORY

Every screen below documents: Purpose · User · Entry points · Components · Actions · Data shown · Empty state · Loading state · Error state · Permissions · Mobile behaviour.

Where a screen is a routine list, the shared **List Screen Pattern** applies and only deviations are documented.

---

## Shared: List Screen Pattern

- **Components:** page header + breadcrumb, optional KPI strip, filter bar (search input, 2–4 selects, date range), data table, pagination footer.
- **Empty state:** centred icon, one-line explanation, primary action button. Filtered-empty differs from truly-empty: filtered shows "no results match your filters" plus a clear-filters action.
- **Loading:** skeleton rows matching final column count. Never a full-page spinner.
- **Error:** inline error card replacing the table body, with retry. Filters remain visible and populated.
- **Mobile:** table converts to stacked cards. Filters collapse into a bottom sheet triggered by a filter button. Pagination becomes load-more.

---

# A. AUTHENTICATION

## A1. Login
| | |
|---|---|
| Purpose | Authenticate a user into their company workspace |
| User | All |
| Entry | Public site header, direct URL, session expiry redirect |
| Components | Logo, email field, password field, show/hide toggle, remember-me, submit, forgot-password link, language switch |
| Actions | Submit credentials, navigate to reset |
| Data | None pre-auth |
| Empty | N/A |
| Loading | Button spinner, fields disabled |
| Error | Single generic message for wrong email or password. Separate messages for locked and deactivated accounts. Rate-limit message after threshold. |
| Permissions | Public |
| Mobile | Single column, full-width fields, 48px targets |

**Rule:** never reveal whether the email exists.

## A2. Forgot password / A3. Reset password
Standard token flow. Forgot-password always returns the same success message regardless of whether the email exists. Reset screen validates token before rendering the form; expired tokens show a re-request action.

## A4. Accept invitation
| | |
|---|---|
| Purpose | New employee sets a password and activates their account |
| Entry | Emailed invitation link |
| Components | Read-only company name + employee name, password, confirm password, password strength meter, terms checkbox |
| Error | Expired invitation → "ask your administrator to resend" |
| Permissions | Public with valid token |

---

# B. ADMIN EXPERIENCE

## B1. Admin Dashboard — `/admin`
| | |
|---|---|
| Purpose | One-glance operational picture of the company today |
| User | ADMIN, MANAGER (team-scoped) |
| Entry | Post-login default, logo click, sidebar item 1 |
| Permissions | `report.company` (admin) / `report.team` (manager) |

**Components, in order:**
1. **Greeting + date strip** — company name, today's date (Hijri optional), quick clock.
2. **KPI cards, row 1 (people):** Total employees · Present · Absent · WFH · Late · On leave.
3. **KPI cards, row 2 (work & money):** Pending requests · Active tasks · Overdue tasks · Monthly payroll · Inventory value · Low-stock products.
4. **Attendance overview** — donut of today's states plus a 30-day presence trend line.
5. **Task overview** — bar or stacked bar by status; list of tasks approaching deadline.
6. **Goal progress** — top 5 goals by proximity to deadline with progress bars.
7. **Pending requests** — 5 most recent, each with inline approve/reject.
8. **Payroll summary** — current period status chip, total gross, total deductions, employee count.
9. **Inventory alerts** — low-stock and out-of-stock product list, max 5.
10. **Recent activity** — last 10 audit events in human-readable form.
11. **Quick actions** — Add employee · Create task · Generate payroll · Add product.

**Data shown:** aggregates only, never raw record dumps.
**Empty:** a brand-new company shows an onboarding checklist instead of empty widgets — Add departments → Add employees → Set working schedule → Invite employees.
**Loading:** each widget loads independently with its own skeleton. The dashboard never blocks on the slowest widget.
**Error:** per-widget error card with retry. One failing widget must not break the page.
**Mobile:** KPI cards become a 2-column grid, then a horizontal scroll strip. Charts stack full-width. Widgets 5–10 collapse into accordions.

**Explicit constraint:** do not add widgets beyond this list. The dashboard must stay readable.

## B2. Employees list — `/admin/employees`
List Screen Pattern. Columns: avatar+name, employee ID, department, position, manager, status chip, joining date, row actions.
Filters: department, position, status, manager, work mode. Search: name, ID, email, phone.
Actions: create, bulk export (V2), row → view/edit/deactivate.
Permissions: `employee.view`.
Empty: "No employees yet" + Add employee.

## B3. Create / Edit employee — `/admin/employees/new`
Sectioned form: Personal (photo, name, email, phone) · Employment (ID, department, position, manager, joining date, status) · Compensation (monthly salary, currency, salary policy override) · Schedule (working schedule template or custom) · Leave (allowance per leave type) · Access (role, send invitation toggle).
Validation: unique email per company, unique employee ID per company, joining date not in the future beyond a configurable tolerance, salary > 0.
Error: field-level messages; **user input is preserved on failure** — never clear the form.
Mobile: sections become an accordion; sticky save bar at the bottom.

## B4. Employee profile — `/admin/employees/:id`
Header: avatar, name, ID, department, position, manager, status chip, joining date, quick actions (edit, deactivate, assign task, assign goal).
Tabs: **Overview · Attendance · Tasks · Goals · Salary · Requests · Monthly Reports.**
- Overview: performance snapshot, current month attendance summary, active tasks count, active goals, leave balance.
- Attendance: month selector, calendar heat view + record table.
- Tasks: filterable task list scoped to this employee.
- Goals: goal cards with progress.
- Salary: current salary, history of salary changes, payslip list. Requires `employee.view_salary`.
- Requests: this employee's requests with status.
- Monthly Reports: month list → report viewer.

Permissions: tab visibility follows permissions; hidden tabs are also blocked server-side.
Mobile: tabs become a horizontally scrollable segmented control.

## B5. Attendance daily board — `/admin/attendance`
| | |
|---|---|
| Purpose | See who is in, remote, late, absent, or on leave today |
| Components | Date picker (default today), state summary chips, department filter, work-mode filter, employee table |
| Columns | Employee, department, work mode (OFFICE/WFH chip), check-in, check-out, working hours, late, status |
| Actions | Manual adjust (audited), export, open record |
| Empty | Non-working day → holiday/weekend illustration with schedule name |
| Mobile | Card list grouped by status, status chip prominent |

## B6. Attendance monthly matrix — `/admin/attendance/monthly`
Employees on rows, days on columns, single coloured cell per day per state. Legend required. Horizontal scroll with a frozen employee column. Cell click opens the record. Mobile: switches to one-employee-at-a-time month view — the matrix is not shrunk.

## B7. Attendance corrections — `/admin/attendance/corrections`
List of correction requests. Detail view shows current recorded values vs requested values side by side, reason, attachment, and requester. Actions: approve, reject with mandatory reason, request more info. Approval writes both the attendance change and an audit record.

## B8. Tasks — `/admin/tasks`
Two views, toggled: **Table** and **Board** (columns = statuses).
Filters: status, priority, assignee, department, goal, date range, overdue-only.
Actions: create, bulk status change (V2), open task.
Empty: "No tasks yet" + Create task.
Mobile: board is a horizontally swipeable single-column-at-a-time view; table becomes cards.

## B9. Task detail — `/admin/tasks/:id`
Header: name, status chip, priority chip, assignee, deadline with overdue indicator, progress ring.
Body: description, checklist with completion state, progress-update timeline, attachments, linked goal, activity/audit strip.
Actions: edit, change status, reassign, change deadline, add checklist item, add attachment, cancel task.
Rules: changing a deadline on an overdue task is audited. Cancelling requires a reason.

## B10. Create / Edit task
Form: name, description, assignee, department (auto from assignee, overridable), priority, start date, deadline, linked goal, checklist builder (add/remove/reorder), attachments.
Validation: deadline ≥ start date; assignee must be active; goal must belong to the same company and, if employee-scoped, the same employee.

## B11. Goals — `/admin/goals` and B12. Goal detail — `/admin/goals/:id`
List: goal name, type chip, owner, target, current, progress bar, period, status.
Detail: progress chart over the period, progress history, linked tasks (for task-type goals), edit and update-progress actions.
Create form: type selector (Sales / Task / Custom), owner, target value + unit, period start/end, description, and — for Task goals — the counting rule (which tasks count).

## B13. Requests inbox — `/admin/requests`
Unified list across categories with category tabs (All / Attendance / Leave / Salary / Task / General) and status filter defaulting to Pending.
Row: employee, category chip, summary, submitted date, age indicator, status.
Detail: full request, attachments, employee context (leave balance for leave requests; the relevant attendance record for corrections), approve/reject with response field, decision history.
Rules: reject requires a reason. Every decision is audited and notifies the employee.

## B14. Payroll periods — `/admin/payroll`
List of periods with state chip (Draft / Under Review / Approved / Finalized / Paid / Adjusted), employee count, gross total, net total.
Primary action: Generate payroll for a period. Blocked if a period already exists in a non-adjustable state.

## B15. Payroll run — `/admin/payroll/:periodId`
Summary strip: employees, total base, total attendance adjustment, total deductions, total bonuses, total net, state.
Table: employee, base salary, attendance adjustment, deductions, bonuses, final salary, status, row actions.
Actions by state:
- Draft → recalculate, add deduction, add bonus, submit for review
- Under Review → approve, return to draft
- Approved → finalize (irreversible, confirmation required with typed confirmation)
- Finalized → mark paid, create adjustment
- Paid → create adjustment only

**Error:** if generation encounters employees with missing salary or missing attendance configuration, generation halts and lists the blocking employees. It does not generate a partially wrong payroll.

## B16. Payslip detail — `/admin/payroll/:periodId/:employeeId`
Full breakdown: base, working days, present days, absent days, unpaid leave days, attendance adjustment, itemized deductions (amount, reason, created by, date), itemized bonuses, net.
Immutable once finalized — the UI shows read-only with an "Add adjustment" action rather than edit fields.

## B17. Reports catalogue — `/admin/reports`
Grid of report cards grouped: Financial · Attendance · Tasks & Goals · Inventory. Each card has an icon, title, one-line description. Click → report viewer.

## B18. Report viewer — `/admin/reports/:reportKey`
Filter bar: date range, department, employee, plus report-specific filters. Result: chart(s) + data table. Actions: export, print.
Empty: "No data for the selected filters" with a suggestion to widen the range.
Mobile: filters in a bottom sheet; charts stack; tables scroll horizontally with a frozen first column.

## B19. Warehouse dashboard — `/admin/warehouse`
KPIs: total products · total stock units · low-stock count · out-of-stock count · total inventory value.
Widgets: stock by location, recent movements (last 20), warehouse activity trend, low-stock table.

## B20. Locations — `/admin/warehouse/locations` and detail
List of locations with type chip (Main / Branch / Store / Production / Online), stock value, product count, status.
Detail: per-product stock at this location, movement history filtered to this location, transfer action.

## B21. Transfers — `/admin/warehouse/transfers`
Create transfer: source location, destination location, products with quantities, note. Executes as a single transaction producing paired OUT and IN movements. Blocked if source quantity is insufficient.

## B22. Products — `/admin/inventory`
List: image, name, SKU, category, unit, total quantity across locations, min stock, status chip (In Stock / Low / Out), cost, selling price.
Filters: category, location, status, supplier. Search: name, SKU.

## B23. Product detail — `/admin/inventory/:id`
Header: image, name, SKU, status chip, total quantity.
Sections: details, per-location stock breakdown, movement history, supplier, pricing, valuation.
Actions: edit, adjust stock (opens movement form), deactivate.
**Rule:** there is no editable "quantity" field. Quantity changes only through a movement.

## B24. Stock movements — `/admin/inventory/movements`
Chronological, filterable by product, location, type, date range, user. Read-only. No edit and no delete actions exist anywhere in the UI.

## B25. Settings screens — `/admin/settings/*`
| Screen | Key contents |
|---|---|
| Company | Name, logo, timezone, currency, locale, address, contact |
| Departments | CRUD list; deletion blocked while employees are assigned |
| Positions | CRUD list |
| Schedules | Working schedule templates: working days, start/end times, break, grace period, overtime rule, holidays |
| Leave types | Type name, default allowance, paid/unpaid, requires attachment, carry-over rule |
| Salary policy | Daily-wage basis, unpaid-leave handling, lateness rule, overtime rule, rounding |
| Performance | Weights for attendance / tasks / goals, and each sub-metric |
| Roles | Role list with permission matrix (read-only in V1 for built-in roles) |
| Notifications | Per-event channel toggles |
| Audit log | Filterable audit trail, read-only, export |

All settings screens warn before saving changes that affect historical calculations, and state explicitly that finalized payroll is not recalculated.

---

# C. EMPLOYEE EXPERIENCE

## C1. Employee dashboard — `/app`
| | |
|---|---|
| Purpose | Show what the employee must act on today |
| Entry | Post-login default |
| Permissions | Authenticated employee |

Components in priority order:
1. Greeting: "صباح الخير، أحمد" with today's date.
2. **Attendance card** — the most prominent element. Two large buttons `[ مكتب OFFICE ]` `[ عن بُعد WFH ]` before check-in; after check-in it shows check-in time, a running duration, and a check-out button.
3. My tasks: due today / in progress / completed counts, plus the next 3 tasks by deadline.
4. My goals: progress bars.
5. Salary: current estimated salary, daily wage, working days, days worked.
6. Leave balance: remaining days.
7. Requests: pending count.

**Empty:** new employee with no tasks or goals sees a welcome card and the attendance action only.
**Loading:** attendance card loads first and independently — it is the primary action.
**Error:** if attendance state cannot load, show an explicit error on the card and disable the buttons. Never render buttons whose result is unknown.
**Mobile:** this is the primary mobile screen. Attendance card is full-width above the fold; everything else scrolls.

## C2. Employee attendance — `/app/attendance`
Today panel (same as dashboard card), plus this month's summary chips (present, WFH, late, absent, leave) and a record list.
Actions: check in with mode, check out, request correction.
Rules: one open attendance record per employee per day. Double check-in returns a clear conflict message, not a duplicate record.

## C3. Attendance history — `/app/attendance/history`
Month selector, calendar view with state colours, tap a day for detail, and a request-correction action per day.

## C4. Attendance correction request — `/app/attendance/correction/new`
Form: date, requested check-in, requested check-out, work mode, reason (required), attachment (optional).
Shows current recorded values above the fields so the employee can see what they are changing.
Validation: date must be in the past and within the correction window (configurable, default 7 days).

## C5. My tasks — `/app/tasks`
Grouped: Due today · Overdue · In progress · Not started · Completed.
Card: name, priority chip, deadline, progress ring.
Mobile: this is a primary mobile screen; cards are full-width and tappable.

## C6. Task detail — `/app/tasks/:id`
Shows name, description, deadline, priority, progress, checklist with tappable items, progress-note composer, attachments, previous updates.
Actions: toggle checklist items, add progress note, upload attachment, change status within allowed transitions.
**Rule:** checking a checklist item updates progress immediately and optimistically, with rollback on failure.

## C7. My goals — `/app/goals/:id`
Read-only. Target, current, progress, period, and — for task goals — the contributing tasks.

## C8. My requests — `/app/requests`, C9. New request, C10. Request detail
List with status chips. New request: category selector then a category-specific form (leave request shows the live balance and calculates the day count as dates are picked). Detail shows the decision, the reviewer, and the admin response.
Employees may cancel only their own Pending requests.

## C11. My salary — `/app/salary`
Current month: monthly salary, estimated current salary, daily wage, working days, days worked, leave balance.
An explicit note states the estimate is provisional until payroll is finalized.
History: list of finalized payslips.

## C12. Payslip — `/app/salary/:periodId`
Read-only breakdown, identical structure to B16 but scoped to self.

## C13. My monthly report — `/app/reports/:month`
Attendance, tasks, goals, salary, and performance sections as specified in DOCUMENT 14 and 18.

## C14. Notifications — `/app/notifications`
Grouped by date, unread emphasised, tap to navigate to the source record, mark-all-read action.

## C15. Profile — `/app/profile`
Read-only employment data (department, position, manager, joining date), editable personal data (photo, phone), password change, language preference.
Employees cannot edit their own salary, department, position, manager, or schedule.

---

# D. PUBLIC WEBSITE
Home · About · Features · For Companies · For Individuals · Pricing · Contact · Login · Register — specified in DOCUMENT 23.

---

# E. SCREEN COUNT SUMMARY

| Area | Screens |
|---|---|
| Authentication | 4 |
| Admin | 25 |
| Employee | 15 |
| Public website | 9 |
| **Total** | **53** |

Every screen above must implement all four states: loading, empty, error, success. A screen missing any of these is not complete.
