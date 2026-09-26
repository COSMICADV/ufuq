# DOCUMENT 07 — ENTITY RELATIONSHIP DIAGRAM

## 1. Tenant core

```
┌──────────────┐
│  companies   │◄──────────────────────────────────┐
└──────┬───────┘                                   │ company_id on
       │ 1                                          │ EVERY business table
       ├──n──► users ──n──1──► roles ──n──n──► permissions
       ├──n──► departments ──1──n──► positions
       ├──n──► employees
       ├──n──► work_schedules ──1──n──► work_schedule_days
       ├──n──► holidays
       ├──n──► leave_types
       ├──n──► salary_policies
       ├──n──► warehouses
       ├──n──► product_categories
       ├──n──► suppliers
       └──n──► audit_logs
```

## 2. People

```
users 1───0..1 employees
                  │
                  ├──n──1  departments
                  ├──n──1  positions
                  ├──n──1  employees        (manager_id, self-reference)
                  ├──n──1  work_schedules
                  ├──1──n  employee_salaries
                  ├──1──n  attendance_records
                  ├──1──n  leave_balances
                  ├──1──n  leave_requests
                  ├──1──n  tasks            (assignee)
                  ├──1──n  goals
                  ├──1──n  requests
                  ├──1──n  payroll_lines
                  └──1──n  monthly_employee_reports
```

`users` and `employees` are separate because an employment record may exist before a login account, and must survive after the account is deactivated.

## 3. Time & absence

```
work_schedules ──1──n── work_schedule_days
       │
       └──n── employees ──1──n── attendance_records
                                       │
                                       ├──n──1 leave_requests   (when on_leave)
                                       └──1──n attendance_correction_requests

leave_types ──1──n── leave_balances ──n──1── employees
      │
      └──1──n── leave_requests
```

Approving a leave request creates attendance records. That link is what makes payroll correct without double entry.

## 4. Work

```
goals ──1──n── goal_progress          (append-only history)
  │
  └──1──n── tasks ──1──n── task_checklist_items
                  └──1──n── task_progress_updates   (append-only history)
```

Checklist completion → task progress → (for task-type goals) goal current value. One direction only. Goals never write back into tasks.

## 5. Money

```
employees ──1──n── employee_salaries ──n──1── salary_policies

payroll_periods ──1──n── payroll_lines ──n──1── employees
                                │
                                ├──1──n── payroll_deductions
                                ├──1──n── payroll_bonuses
                                └──1──n── payroll_adjustments
```

`payroll_lines.snapshot` freezes the inputs at finalization. `payroll_adjustments` is the only path to changing a finalized outcome — the original line is never touched.

## 6. Stock

```
warehouses ──┐
             ├──1──n── product_stock ──n──1── products
             └──1──n── stock_movements ──n──1── products
                              │
                              └── transfer_group_id links the paired
                                  transfer_out / transfer_in rows

products ──n──1── product_categories
products ──n──1── suppliers
```

`product_stock` is a derived cache. `stock_movements` is the source of truth and is immutable. The cache must be rebuildable from the movements at any time — a reconciliation job proves this in testing.

## 7. Cross-cutting

```
audit_logs   ──n──1── users        polymorphic (entity_type, entity_id)
notifications ──n──1── users       polymorphic (related_type, related_id)
attachments  ──n──1── users        polymorphic (related_type, related_id)
```

Polymorphic references are indexed on `(entity_type, entity_id)`. They carry no database-level foreign key, so integrity is enforced in the service layer and orphans are cleaned by a scheduled job.

## 8. Cardinality summary

| Relationship | Cardinality | Delete behaviour |
|---|---|---|
| company → users | 1:n | RESTRICT |
| company → employees | 1:n | RESTRICT |
| user → employee | 1:0..1 | SET NULL |
| employee → manager | n:1 self | SET NULL |
| employee → attendance_records | 1:n | RESTRICT |
| leave_request → attendance_records | 1:n | RESTRICT |
| task → checklist_items | 1:n | CASCADE |
| task → progress_updates | 1:n | CASCADE |
| goal → tasks | 1:n | SET NULL |
| goal → goal_progress | 1:n | CASCADE |
| payroll_period → payroll_lines | 1:n | RESTRICT |
| payroll_line → deductions/bonuses | 1:n | RESTRICT |
| product → stock_movements | 1:n | RESTRICT |
| warehouse → product_stock | 1:n | RESTRICT |
| role → permissions | n:n | CASCADE on join table |

## 9. Integrity invariants

These must hold at all times. Each is a test case in DOCUMENT 26.

1. `attendance_records` has at most one row per `(employee_id, date)`.
2. `leave_balances.used + pending ≤ total + carried_over`, unless the leave type allows a negative balance.
3. `tasks.progress_percent` equals `completed_checklist_items / total_checklist_items × 100`, or the manually set value when the task has no checklist.
4. `product_stock.quantity` equals the sum of `stock_movements.quantity` for that `(product_id, warehouse_id)`.
5. Every `transfer_out` movement has exactly one matching `transfer_in` with the same `transfer_group_id` and the opposite sign.
6. `payroll_lines.net_salary` = `base_salary + attendance_adjustment − total_deductions + total_bonuses`.
7. No row in any business table has a `company_id` differing from the `company_id` of any row it references.
8. A locked `payroll_line` has no `updated_at` later than its period's `finalized_at`.

Invariant 7 is the tenancy invariant. It is the single most important constraint in the system.
