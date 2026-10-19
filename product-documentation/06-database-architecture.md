# DOCUMENT 06 — DATABASE ARCHITECTURE

## 1. Principles

1. **Multi-tenant from migration one.** Every business table carries `company_id`. There is no "add tenancy later".
2. **Money is `DECIMAL(15,2)`.** Never float, never double, never integer-cents-without-documentation.
3. **Derived quantities are derived.** Stock quantity and task progress are recomputed from their source tables, not free-typed.
4. **Append-only where financial.** Payroll lines and stock movements are inserted, never updated after finalization.
5. **Soft delete on business entities.** `deleted_at TIMESTAMP NULL`. Hard delete only via an audited administrative process.
6. **Every table has** `id`, `created_at`, `updated_at`, and — where a user causes the row — `created_by`.
7. **Enums are lookup tables or database enums**, never magic strings scattered in code.

## 2. Conventions

| Convention | Rule |
|---|---|
| Table names | plural, snake_case |
| Primary key | `id` UUID v7 (time-ordered) or BIGINT identity — see OD-12 |
| Foreign key | `<singular>_id` |
| Timestamps | UTC, stored with timezone; rendered in company timezone |
| Booleans | `is_` prefix |
| Money | `DECIMAL(15,2)` + `currency CHAR(3)` where cross-currency is possible |
| Percentages | `DECIMAL(5,2)` |
| Enum columns | lowercase snake_case values |

## 3. Entity catalogue

### 3.1 companies
Purpose: the tenant root.

| Field | Type | Req | Notes |
|---|---|---|---|
| id | PK | ✅ | |
| name | VARCHAR(200) | ✅ | |
| slug | VARCHAR(100) | ✅ | unique |
| logo_path | VARCHAR(500) | | |
| timezone | VARCHAR(64) | ✅ | IANA, e.g. Africa/Cairo |
| currency | CHAR(3) | ✅ | default EGP |
| default_locale | CHAR(5) | ✅ | default `ar` |
| fiscal_month_start_day | SMALLINT | ✅ | default 1 |
| status | ENUM | ✅ | active, suspended, cancelled |
| deleted_at | TIMESTAMP | | |

Indexes: `slug` unique · `status`.

### 3.2 users
Purpose: authentication identity.

| Field | Type | Req | Notes |
|---|---|---|---|
| id | PK | ✅ | |
| company_id | FK companies | ✅ | |
| email | VARCHAR(255) | ✅ | unique per company |
| password_hash | VARCHAR(255) | | null until invitation accepted |
| role_id | FK roles | ✅ | |
| locale | CHAR(5) | | overrides company default |
| status | ENUM | ✅ | invited, active, deactivated |
| last_login_at | TIMESTAMP | | |
| failed_login_count | SMALLINT | ✅ | default 0 |
| locked_until | TIMESTAMP | | |
| email_verified_at | TIMESTAMP | | |
| deleted_at | TIMESTAMP | | |

Constraints: unique `(company_id, email)`. Never unique on email globally — the same person may exist in two companies later.
Indexes: `(company_id, status)`.

### 3.3 roles / permissions / role_permissions

**roles**: `id`, `company_id` (NULL = system role), `key` (super_admin, admin, manager, employee), `name_ar`, `name_en`, `is_system`.
**permissions**: `id`, `key` (`payroll.finalize`), `module`, `description_ar`, `description_en`.
**role_permissions**: `role_id`, `permission_id`, `scope` ENUM(self, team, company, platform). PK `(role_id, permission_id)`.

Adding a role later = data insert, no code change.

### 3.4 departments
`id`, `company_id`, `name_ar`, `name_en`, `parent_id` (nullable, tree-ready), `manager_employee_id` (nullable), `status`, `deleted_at`.
Unique `(company_id, name_ar)`. Deletion blocked while active employees are assigned.

### 3.5 positions
`id`, `company_id`, `title_ar`, `title_en`, `department_id` (nullable), `deleted_at`.

### 3.6 employees
Purpose: the employment record. Separate from `users` because employment data outlives and differs from login identity.

| Field | Type | Req | Notes |
|---|---|---|---|
| id | PK | ✅ | |
| company_id | FK | ✅ | |
| user_id | FK users | | nullable — an employee may exist before an account |
| employee_code | VARCHAR(50) | ✅ | unique per company |
| first_name / last_name | VARCHAR(100) | ✅ | |
| photo_path | VARCHAR(500) | | |
| email / phone | VARCHAR | | |
| department_id | FK | | |
| position_id | FK | | |
| manager_id | FK employees | | self-reference |
| work_schedule_id | FK | ✅ | |
| joining_date | DATE | ✅ | |
| status | ENUM | ✅ | active, inactive, terminated |
| termination_date | DATE | | |
| deleted_at | TIMESTAMP | | |

Indexes: `(company_id, status)` · `(company_id, department_id)` · `manager_id` · unique `(company_id, employee_code)`.
Constraint: `manager_id` must belong to the same company. Cycle prevention enforced in the service layer.

### 3.7 work_schedules
`id`, `company_id`, `name`, `is_default`, `timezone`, `grace_period_minutes`, `half_day_threshold_hours`, `overtime_policy` ENUM(none, paid, banked), `break_minutes`, `deleted_at`.

### 3.8 work_schedule_days
`id`, `work_schedule_id`, `day_of_week` SMALLINT (0–6), `is_working_day` BOOL, `start_time` TIME, `end_time` TIME.
Unique `(work_schedule_id, day_of_week)`.

**Working days and hours are never hardcoded.** Saturday–Thursday 09:00–17:00 with Friday off is only a seed example.

### 3.9 holidays
`id`, `company_id`, `date`, `name_ar`, `name_en`, `is_recurring`.
Unique `(company_id, date)`.

### 3.10 attendance_records

| Field | Type | Req | Notes |
|---|---|---|---|
| id | PK | ✅ | |
| company_id | FK | ✅ | |
| employee_id | FK | ✅ | |
| date | DATE | ✅ | |
| work_mode | ENUM | | office, wfh, null when absent/leave |
| check_in_at | TIMESTAMP | | |
| check_out_at | TIMESTAMP | | |
| working_minutes | INT | | derived |
| overtime_minutes | INT | | derived |
| late_minutes | INT | | derived |
| status | ENUM | ✅ | present, absent, late, on_leave, half_day, holiday, weekend, pending |
| source | ENUM | ✅ | self, admin, correction, system |
| leave_request_id | FK | | set when status = on_leave |
| note | TEXT | | |
| created_by | FK users | | |

Constraints: unique `(employee_id, date)` — one record per employee per day.
Indexes: `(company_id, date)` · `(employee_id, date)` · `(company_id, status, date)`.

`work_mode` is a first-class column, not a note. OFFICE and WFH must be queryable and reportable.

### 3.11 attendance_correction_requests
`id`, `company_id`, `employee_id`, `attendance_record_id` (nullable — the day may have no record), `date`, `requested_check_in`, `requested_check_out`, `requested_work_mode`, `reason` TEXT, `attachment_id`, `status` ENUM(pending, approved, rejected, cancelled), `reviewed_by`, `reviewed_at`, `review_note`.

### 3.12 leave_types
`id`, `company_id`, `name_ar`, `name_en`, `is_paid` BOOL, `default_days_per_year` DECIMAL(5,2), `requires_attachment` BOOL, `allows_negative_balance` BOOL, `carry_over_policy` ENUM(none, full, capped), `carry_over_cap`, `deleted_at`.

### 3.13 leave_balances
`id`, `company_id`, `employee_id`, `leave_type_id`, `year` SMALLINT, `total_days`, `used_days`, `pending_days`, `carried_over_days`.
Unique `(employee_id, leave_type_id, year)`.
`remaining = total + carried_over − used − pending`. Remaining is **computed**, not stored.

### 3.14 leave_requests
`id`, `company_id`, `employee_id`, `leave_type_id`, `start_date`, `end_date`, `days_count` DECIMAL(5,2), `reason`, `attachment_id`, `status` ENUM(pending, approved, rejected, cancelled), `reviewed_by`, `reviewed_at`, `review_note`.
Indexes: `(company_id, status)` · `(employee_id, start_date)`.

### 3.15 tasks

| Field | Type | Req | Notes |
|---|---|---|---|
| id | PK | ✅ | |
| company_id | FK | ✅ | |
| title | VARCHAR(255) | ✅ | |
| description | TEXT | | |
| assignee_employee_id | FK | ✅ | |
| department_id | FK | | |
| goal_id | FK goals | | |
| priority | ENUM | ✅ | low, medium, high, urgent |
| status | ENUM | ✅ | not_started, in_progress, completed, cancelled, on_hold |
| start_date | DATE | | |
| deadline | DATE | | |
| completed_at | TIMESTAMP | | |
| progress_percent | DECIMAL(5,2) | ✅ | derived, default 0 |
| created_by | FK users | ✅ | |
| cancelled_reason | TEXT | | |
| deleted_at | TIMESTAMP | | |

`overdue` is **not** a stored status. It is `deadline < CURRENT_DATE AND status NOT IN (completed, cancelled)`.
Indexes: `(company_id, status)` · `(assignee_employee_id, status)` · `(company_id, deadline)`.

### 3.16 task_checklist_items
`id`, `task_id`, `title`, `is_completed`, `completed_at`, `completed_by`, `position` INT.
Index `(task_id, position)`.

### 3.17 task_progress_updates
`id`, `task_id`, `employee_id`, `note` TEXT, `progress_percent_at_time`, `created_at`.
Append-only. Provides progress history.

### 3.18 goals
`id`, `company_id`, `employee_id`, `type` ENUM(sales, task, custom), `title`, `description`, `target_value` DECIMAL(15,2), `current_value` DECIMAL(15,2), `unit` VARCHAR(20), `period_start`, `period_end`, `status` ENUM(active, achieved, missed, cancelled), `task_count_rule` JSON (task type only), `created_by`, `deleted_at`.

`progress_percent` is computed: `current / target × 100`. Stored only as a denormalized cache if measured necessary, and then always recomputed on write.

### 3.19 goal_progress
`id`, `goal_id`, `value`, `previous_value`, `note`, `source` ENUM(manual, system), `created_by`, `created_at`.
Append-only history. Never update in place.

### 3.20 requests
Purpose: the unified Requests Centre. Attendance corrections and leave requests keep their specialised tables; `requests` is the inbox row that points at them, plus the home for salary/task/general requests.

`id`, `company_id`, `employee_id`, `category` ENUM(attendance, leave, salary, task, general), `subject`, `description`, `related_type` VARCHAR(50), `related_id`, `status` ENUM(pending, approved, rejected, cancelled), `reviewed_by`, `reviewed_at`, `admin_response`, `created_at`.
Index `(company_id, status, created_at)`.

> Alternative single-table design considered and rejected: specialised approval logic and validation differ enough per category that one wide table would become a field-nullability swamp. See OD-09 if a reviewer prefers otherwise.

### 3.21 employee_salaries
Salary history, not a mutable field on `employees`.

`id`, `company_id`, `employee_id`, `monthly_salary` DECIMAL(15,2), `currency`, `effective_from` DATE, `effective_to` DATE (null = current), `salary_policy_id`, `created_by`, `note`.
Index `(employee_id, effective_from)`.
Rule: changing a salary **closes** the current row and inserts a new one. It never updates the amount in place.

### 3.22 salary_policies
`id`, `company_id`, `name`, `daily_wage_basis` ENUM(fixed_days, scheduled_working_days, calendar_days), `fixed_days_value` SMALLINT, `unpaid_leave_deduction` ENUM(daily_wage, scheduled_day_wage, none), `absence_deduction` ENUM(daily_wage, none), `lateness_rule` JSON, `overtime_rate` DECIMAL(5,2), `rounding` ENUM(none, nearest, up, down), `is_default`.

Salary calculation is **configuration**, not code.

### 3.23 payroll_periods
`id`, `company_id`, `year`, `month`, `start_date`, `end_date`, `status` ENUM(draft, under_review, approved, finalized, paid, adjusted), `generated_by`, `generated_at`, `finalized_by`, `finalized_at`, `paid_at`, `total_gross`, `total_deductions`, `total_bonuses`, `total_net`.
Unique `(company_id, year, month)`.

### 3.24 payroll_lines
`id`, `payroll_period_id`, `company_id`, `employee_id`, `base_salary`, `daily_wage`, `working_days`, `present_days`, `wfh_days`, `absent_days`, `paid_leave_days`, `unpaid_leave_days`, `late_minutes_total`, `attendance_adjustment`, `total_deductions`, `total_bonuses`, `net_salary`, `status`, `snapshot` JSON, `is_locked` BOOL.
Unique `(payroll_period_id, employee_id)`.

`snapshot` stores the full computed inputs at finalization so a later change to schedules or policies can never silently rewrite history.
**Once `is_locked` is true, UPDATE is forbidden at the application layer and, where supported, by a database trigger.**

### 3.25 payroll_deductions / payroll_bonuses
`id`, `payroll_line_id`, `company_id`, `type`, `amount` DECIMAL(15,2), `reason` TEXT (required), `created_by`, `created_at`.
Append-only.

### 3.26 payroll_adjustments
`id`, `original_payroll_line_id`, `company_id`, `employee_id`, `amount` (signed), `reason` (required), `created_by`, `created_at`, `approved_by`, `approved_at`.
The only legal way to change a finalized payroll outcome.

### 3.27 monthly_employee_reports
`id`, `company_id`, `employee_id`, `year`, `month`, `attendance_summary` JSON, `task_summary` JSON, `goal_summary` JSON, `salary_summary` JSON, `performance_scores` JSON, `overall_score` DECIMAL(5,2), `generated_at`, `is_provisional` BOOL.
Unique `(employee_id, year, month)`. A snapshot, regenerated only by explicit audited action.

Phase 12 (amendment): `generated_by` (the user, or the company's system actor for the scheduled job), `source_fingerprint` CHAR(64) — the SHA-256 of the snapshot's content as computed from the sources, which a read recomputes to say whether the underlying data has changed (DOCUMENT 18 rule 2) — and `revision` INT (1, then +1 per regeneration). The database refuses an UPDATE that is not a regeneration (next revision, later `generated_at`, same employee and month) and refuses DELETE. `performance_scores` holds the full calculation with the configuration and weights in effect.

### 3.27a report_exports (Phase 12)
`id`, `company_id`, `requested_by`, `report_key`, `format` (`csv`), `filters` JSON, `scope` JSON, `locale`, `status` ENUM(queued, running, completed, failed), `row_count`, `storage_key`, `failure_reason`, `created_at`, `started_at`, `completed_at`.
A background export job (DOCUMENT 18 "Performance") and where its finished file lies in private object storage. Not a reporting truth; never deleted.

### 3.28 warehouses
`id`, `company_id`, `name_ar`, `name_en`, `type` ENUM(main, branch, store, production, online), `address`, `is_active`, `deleted_at`.

One unified model covers physical and online inventory. There are **not** two inventory systems.

### 3.29 products
`id`, `company_id`, `name_ar`, `name_en`, `sku`, `category_id`, `unit` VARCHAR(20), `min_stock` DECIMAL(15,3), `cost_price` DECIMAL(15,2), `selling_price` DECIMAL(15,2), `supplier_id`, `image_path`, `description`, `status` ENUM(active, discontinued), `deleted_at`.
Unique `(company_id, sku)`.

### 3.30 product_categories
`id`, `company_id`, `name_ar`, `name_en`, `parent_id`.

### 3.31 product_stock
The current balance per product per warehouse. A **derived cache** of `stock_movements`.

`id`, `company_id`, `product_id`, `warehouse_id`, `quantity` DECIMAL(15,3), `average_cost` DECIMAL(15,2), `updated_at`.
Unique `(product_id, warehouse_id)`.
Rule: only the stock-movement service writes this table, inside the same transaction as the movement. A reconciliation job can rebuild it entirely from movements.

### 3.32 stock_movements
`id`, `company_id`, `product_id`, `warehouse_id`, `type` ENUM(purchase, sale, transfer_in, transfer_out, adjustment, return, damage, manual_addition, manual_removal), `quantity` DECIMAL(15,3) (signed), `unit_cost`, `balance_after` DECIMAL(15,3), `reference_type`, `reference_id`, `transfer_group_id` UUID, `reason` TEXT, `created_by`, `created_at`.

**Immutable. No UPDATE. No DELETE.** A mistake is corrected by an opposing adjustment movement, never by editing history.
Indexes: `(company_id, product_id, created_at)` · `(warehouse_id, created_at)` · `transfer_group_id`.

### 3.33 suppliers
`id`, `company_id`, `name`, `contact_person`, `phone`, `email`, `address`, `status`, `deleted_at`.

### 3.34 notifications
`id`, `company_id`, `user_id`, `type`, `title_ar`, `title_en`, `body_ar`, `body_en`, `related_type`, `related_id`, `channel` ENUM(in_app, email, push), `read_at`, `created_at`.
Index `(user_id, read_at, created_at)`.

### 3.35 audit_logs
`id`, `company_id`, `user_id`, `action`, `entity_type`, `entity_id`, `old_values` JSON, `new_values` JSON, `ip_address`, `user_agent`, `created_at`.
**Append-only.** No UPDATE, no DELETE, no soft delete.
Indexes: `(company_id, created_at)` · `(entity_type, entity_id)` · `(user_id, created_at)`.

### 3.36 attachments
`id`, `company_id`, `uploaded_by`, `original_name`, `stored_path`, `mime_type`, `size_bytes`, `checksum`, `related_type`, `related_id`, `created_at`, `deleted_at`.
`stored_path` uses a non-guessable key. Files are served through an authorization-checked endpoint, never as public URLs.

### 3.37 sessions / password_reset_tokens / invitations
Standard auth support tables. Tokens are stored hashed, single-use, with expiry.

## 4. Relationship map

```
companies 1─n users            companies 1─n employees
companies 1─n departments      companies 1─n warehouses
roles 1─n users                roles n─n permissions
employees 1─1 users (optional) employees n─1 departments
employees n─1 positions        employees n─1 employees (manager)
employees n─1 work_schedules   work_schedules 1─n work_schedule_days
employees 1─n attendance_records
employees 1─n leave_balances   leave_types 1─n leave_balances
employees 1─n leave_requests   leave_requests 1─n attendance_records
employees 1─n tasks (assignee) tasks 1─n task_checklist_items
tasks 1─n task_progress_updates
tasks n─1 goals                goals 1─n goal_progress
employees 1─n employee_salaries
payroll_periods 1─n payroll_lines
payroll_lines 1─n payroll_deductions / payroll_bonuses / payroll_adjustments
products 1─n product_stock     warehouses 1─n product_stock
products 1─n stock_movements   warehouses 1─n stock_movements
products n─1 suppliers         products n─1 product_categories
users 1─n notifications        users 1─n audit_logs
```

## 5. Keys, constraints, indexes

**Primary keys:** every table, single-column surrogate.

**Foreign keys:** enforced at the database level with explicit `ON DELETE` behaviour:
- `RESTRICT` for anything financial or historical (payroll, movements, audit).
- `CASCADE` only for genuinely owned children: `task_checklist_items`, `work_schedule_days`, `role_permissions`.
- `SET NULL` for optional references such as `manager_id`.

**Unique constraints:**
`(company_id, email)` on users · `(company_id, employee_code)` on employees · `(employee_id, date)` on attendance_records · `(employee_id, leave_type_id, year)` on leave_balances · `(company_id, year, month)` on payroll_periods · `(payroll_period_id, employee_id)` on payroll_lines · `(company_id, sku)` on products · `(product_id, warehouse_id)` on product_stock · `(company_id, slug)` on companies.

**Composite indexes** — every one exists because a documented query needs it:

| Index | Serves |
|---|---|
| `attendance(company_id, date, status)` | daily attendance board |
| `attendance(employee_id, date)` | employee history, payroll generation |
| `tasks(assignee_employee_id, status)` | my-tasks list |
| `tasks(company_id, deadline)` | overdue and approaching-deadline widgets |
| `stock_movements(company_id, product_id, created_at)` | product movement history |
| `notifications(user_id, read_at)` | unread badge |
| `audit_logs(entity_type, entity_id)` | record history view |
| `leave_requests(company_id, status)` | pending approvals |

**Every business table is indexed on `company_id`**, leading or included, because every query is tenant-scoped.

## 6. Soft-delete strategy

| Category | Strategy | Reason |
|---|---|---|
| Reference data (departments, positions, products, leave types) | Soft delete | Historical records still reference them |
| Employees | Status change (`terminated`) + soft delete | Payroll and attendance history must survive |
| Tasks, goals | Soft delete | Reporting integrity |
| Attendance records | Never deleted; corrected via an audited update | Payroll depends on them |
| Payroll lines | Never deleted | Financial record |
| Stock movements | Never deleted | Inventory audit |
| Audit logs | Never deleted | Compliance |
| Notifications | Hard delete permitted after a retention window | No business value |

Soft-deleted rows are excluded by a default query scope. Reports that intentionally include historical entities must opt in explicitly.

## 7. Audit strategy

Audited actions are enumerated in DOCUMENT 21. The mechanism:

1. The service layer emits an audit event after a successful transaction commits.
2. The event captures `old_values` and `new_values` as JSON, restricted to changed fields.
3. Sensitive fields (`password_hash`, tokens) are never written to audit values.
4. Audit writes are asynchronous where volume demands it, but must not be silently dropped — a failed audit write is logged and retried.
5. Audit records are queryable per entity to power a "history" panel on employee, task, payroll, and product screens.

## 8. Transaction requirements

These operations **must** run inside a single transaction:

- Employee creation (user + employee + leave balances + salary record)
- Leave approval (balance update + attendance record creation + request status)
- Attendance correction approval (record update + request status)
- Payroll generation (all lines for the period)
- Payroll finalization (snapshot + lock + period state)
- Any deduction, bonus, or adjustment (line recalculation)
- Any stock movement (movement insert + `product_stock` update)
- Stock transfer (two paired movements + two stock updates)
- Product creation with initial stock

A partial write in any of these is a defect, not an edge case.

## 9. Data retention

| Data | Retention |
|---|---|
| Audit logs | 7 years minimum |
| Payroll records | 7 years minimum |
| Stock movements | 7 years minimum |
| Attendance records | 5 years |
| Notifications | 12 months |
| Sessions | until expiry + 30 days |
| Soft-deleted rows | indefinite unless a legal erasure request applies |

Legal retention periods vary by jurisdiction. Confirm before launch — see OD-14.
