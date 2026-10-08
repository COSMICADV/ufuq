# DOCUMENT 08 — API ARCHITECTURE

## 1. Conventions

| Aspect | Rule |
|---|---|
| Style | REST |
| Base | `/api/v1` |
| Format | JSON, UTF-8 |
| Auth | `Authorization: Bearer <token>` (or session cookie for the web client — see OD-02) |
| Locale | `Accept-Language: ar` / `en`; default `ar` |
| Tenancy | Derived from the authenticated user. **Never** from a request parameter. |
| Naming | plural nouns, kebab-free, snake_case fields |
| Dates | ISO 8601, UTC in transport, company timezone in presentation |
| Money | string decimal, e.g. `"20000.00"`, with an explicit `currency` field |
| Pagination | `?page=1&per_page=20`, max 100 |
| Sorting | `?sort=field&order=asc\|desc`, whitelist per endpoint |

### Critical rule
`company_id` is **never** accepted from the client. Any endpoint that reads a company identifier from the request body or query string is a security defect.

## 2. Standard responses

**Success (single):**
```json
{ "data": { }, "meta": { } }
```

**Success (collection):**
```json
{
  "data": [ ],
  "meta": { "page": 1, "per_page": 20, "total": 143, "total_pages": 8 }
}
```

**Error:**
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message_ar": "بعض الحقول غير صحيحة",
    "message_en": "Some fields are invalid",
    "fields": { "email": ["already_taken"] }
  }
}
```

## 3. Status codes

| Code | Use |
|---|---|
| 200 | Success |
| 201 | Created |
| 204 | Deleted / no content |
| 400 | Malformed request |
| 401 | Unauthenticated or expired session |
| 403 | Authenticated but not permitted |
| 404 | Not found **or outside tenant scope** |
| 409 | Business conflict (already checked in, duplicate period, insufficient stock) |
| 422 | Validation failed |
| 429 | Rate limited |
| 500 | Server error (never leaks internals) |

Cross-tenant access returns **404, not 403** — do not confirm that another company's record exists.

## 4. Endpoints

Legend: 🔓 public · 🔒 authenticated · `perm:` required permission.

### 4.1 Authentication
| Method | Endpoint | Auth | Notes |
|---|---|---|---|
| POST | `/auth/login` | 🔓 | rate limited, generic failure message |
| POST | `/auth/logout` | 🔒 | invalidates session |
| POST | `/auth/forgot-password` | 🔓 | always 200, always the same message |
| POST | `/auth/reset-password` | 🔓 | token single-use |
| POST | `/auth/accept-invitation` | 🔓 | token single-use |
| GET | `/auth/me` | 🔒 | user, employee, role, permissions, company settings |
| POST | `/auth/change-password` | 🔒 | requires current password |

### 4.2 Company & settings
| Method | Endpoint | perm |
|---|---|---|
| GET | `/company` | settings.view |
| PATCH | `/company` | settings.update |
| GET/POST | `/departments` | settings.view / settings.update |
| PATCH/DELETE | `/departments/{id}` | settings.update |
| GET/POST | `/positions` | settings.view / settings.update |
| GET/POST | `/work-schedules` | settings.view / settings.work_schedule |
| PATCH | `/work-schedules/{id}` | settings.work_schedule |
| GET/POST | `/holidays` | settings.view / settings.update |
| GET/POST | `/leave-types` | settings.view (a `leave.request` holder reads active types) / leave.configure_types |
| PATCH/DELETE | `/leave-types/{id}` | leave.configure_types · DELETE is a soft delete (Phase 10) |
| GET/PATCH | `/salary-policies` | settings.view / settings.salary_policy |
| GET/PATCH | `/performance-config` | settings.view / settings.performance_weights |
| GET | `/roles` | settings.view |

### 4.3 Employees
| Method | Endpoint | perm | Notes |
|---|---|---|---|
| GET | `/employees` | employee.view | filters: department_id, position_id, status, manager_id · search: name, code, email · sort: name, joining_date, department |
| POST | `/employees` | employee.create | transactional, see FLOW 02 |
| GET | `/employees/{id}` | employee.view | scope-checked |
| PATCH | `/employees/{id}` | employee.update | |
| POST | `/employees/{id}/deactivate` | employee.deactivate | reason required |
| POST | `/employees/{id}/activate` | employee.deactivate | |
| POST | `/employees/{id}/invite` | employee.create | resend invitation |
| GET | `/employees/{id}/salary` | employee.view_salary | history |
| POST | `/employees/{id}/salary` | employee.set_salary | closes current row, inserts new |
| GET | `/employees/{id}/attendance` | attendance.view | ?month=YYYY-MM |
| GET | `/employees/{id}/performance` | report.employee_monthly | |
| GET | `/employees/{id}/monthly-reports` | report.employee_monthly | |

**POST /employees request:**
```json
{
  "first_name": "أحمد", "last_name": "محمد",
  "email": "ahmed@company.com", "phone": "+201000000000",
  "employee_code": "EMP-0042",
  "department_id": "…", "position_id": "…", "manager_id": "…",
  "joining_date": "2026-01-15",
  "work_schedule_id": "…",
  "monthly_salary": "20000.00",
  "leave_allowances": [ { "leave_type_id": "…", "days": "21.00" } ],
  "role_key": "employee",
  "send_invitation": true
}
```
Validation: names required · email unique per company · `employee_code` unique per company · `joining_date` valid · `monthly_salary` > 0 · referenced ids in the same company · `manager_id` ≠ self.

### 4.4 Attendance
| Method | Endpoint | perm | Notes |
|---|---|---|---|
| POST | `/attendance/check-in` | attendance.check_in | body: `{ "work_mode": "office"\|"wfh" }` · 409 if already checked in |
| POST | `/attendance/check-out` | attendance.check_out | 409 if no open record |
| GET | `/attendance/today` | attendance.check_in | caller's own state |
| GET | `/attendance` | attendance.view | ?date= or ?from=&to= · filters: department_id, employee_id, status, work_mode |
| GET | `/attendance/monthly` | attendance.view | ?month=YYYY-MM → matrix payload |
| PATCH | `/attendance/{id}` | attendance.update | admin correction, reason required, audited |
| GET | `/attendance/summary` | attendance.view | dashboard counts |

### 4.5 Attendance corrections
| Method | Endpoint | perm |
|---|---|---|
| POST | `/attendance-corrections` | attendance.request_correction |
| GET | `/attendance-corrections` | attendance.approve_correction (or self) |
| GET | `/attendance-corrections/{id}` | scope-checked |
| POST | `/attendance-corrections/{id}/approve` | attendance.approve_correction |
| POST | `/attendance-corrections/{id}/reject` | attendance.approve_correction · reason required |
| POST | `/attendance-corrections/{id}/cancel` | own, pending only |

### 4.6 Leave
| Method | Endpoint | perm |
|---|---|---|
| GET | `/leave-balances` | leave.view |
| GET | `/leave-balances/me` | authenticated |
| PATCH | `/leave-balances/{id}` | leave.adjust_balance · reason required |
| POST | `/leave-requests` | leave.request |
| GET | `/leave-requests` | leave.view · filters: status, leave_type_id, employee_id, date range |
| GET | `/leave-requests/{id}` | scope-checked |
| POST | `/leave-requests/{id}/approve` | leave.approve |
| POST | `/leave-requests/{id}/reject` | leave.approve · reason required |
| POST | `/leave-requests/{id}/cancel` | own, pending only; or an ADMIN (`leave.approve` at company scope, never their own) cancelling **approved** leave, reason required — DOCUMENT 16 rule 15 (amended in Phase 10) |
| GET | `/leave-requests/calculate` | leave.request · returns day count for a date range |

### 4.7 Tasks
| Method | Endpoint | perm |
|---|---|---|
| GET | `/tasks` | task.view · filters: status, priority, assignee, department, goal_id, overdue, date range |
| POST | `/tasks` | task.create |
| GET | `/tasks/{id}` | task.view |
| PATCH | `/tasks/{id}` | task.update |
| DELETE | `/tasks/{id}` | task.delete · soft delete |
| POST | `/tasks/{id}/status` | task.update_status · validates transition |
| POST | `/tasks/{id}/progress-updates` | task.add_progress_note |
| GET | `/tasks/{id}/progress-updates` | task.view |
| POST | `/tasks/{id}/checklist` | task.update |
| PATCH | `/tasks/{id}/checklist/{itemId}` | task.update_checklist |
| DELETE | `/tasks/{id}/checklist/{itemId}` | task.update |
| GET | `/tasks/summary` | task.view · dashboard counts |

### 4.8 Goals
| Method | Endpoint | perm |
|---|---|---|
| GET/POST | `/goals` | goal.view / goal.create |
| GET/PATCH/DELETE | `/goals/{id}` | goal.view / goal.update |
| POST | `/goals/{id}/progress` | goal.update_progress |
| GET | `/goals/{id}/progress` | goal.view · history |

### 4.9 Requests
| Method | Endpoint | perm |
|---|---|---|
| GET | `/requests` | request.view · filters: category, status, employee_id, date range |
| POST | `/requests` | request.create |
| GET | `/requests/{id}` | scope-checked |
| POST | `/requests/{id}/approve` | request.review |
| POST | `/requests/{id}/reject` | request.review · reason required |
| POST | `/requests/{id}/cancel` | own, pending only |
| GET | `/requests/pending-count` | request.view · badge |

### 4.10 Payroll
| Method | Endpoint | perm | Notes |
|---|---|---|---|
| GET | `/payroll/periods` | payroll.view | |
| POST | `/payroll/periods` | payroll.generate | 409 if a non-draft period exists |
| GET | `/payroll/periods/{id}` | payroll.view | run summary + lines |
| POST | `/payroll/periods/{id}/recalculate` | payroll.generate | draft only |
| POST | `/payroll/periods/{id}/submit-review` | payroll.approve | |
| POST | `/payroll/periods/{id}/approve` | payroll.approve | |
| POST | `/payroll/periods/{id}/finalize` | payroll.finalize | irreversible, `{ "confirm": "2026-09" }` |
| POST | `/payroll/periods/{id}/mark-paid` | payroll.mark_paid | |
| GET | `/payroll/lines/{id}` | payroll.view | payslip |
| POST | `/payroll/lines/{id}/deductions` | payroll.add_deduction | 409 if locked |
| POST | `/payroll/lines/{id}/bonuses` | payroll.add_bonus | 409 if locked |
| POST | `/payroll/lines/{id}/adjustments` | payroll.adjust | only when finalized/paid |
| GET | `/payroll/me` | authenticated | own current estimate |
| GET | `/payroll/me/history` | authenticated | own payslips |

`POST /payroll/periods` returns **422 with a blocking list** if any employee lacks salary, schedule, or attendance data. It does not generate a partial run.

### 4.11 Warehouse & inventory
| Method | Endpoint | perm |
|---|---|---|
| GET/POST | `/warehouses` | warehouse.view / warehouse.manage |
| GET/PATCH | `/warehouses/{id}` | warehouse.view / warehouse.manage |
| GET | `/warehouses/{id}/stock` | stock.view |
| GET | `/warehouses/dashboard` | warehouse.view |
| POST | `/warehouses/transfers` | stock.transfer · transactional paired movements |
| GET/POST | `/products` | product.view / product.create |
| GET/PATCH | `/products/{id}` | product.view / product.update |
| GET | `/products/{id}/stock` | stock.view · per location |
| GET | `/products/{id}/movements` | stock.view |
| POST | `/stock-movements` | stock.movement_create |
| GET | `/stock-movements` | stock.view · filters: product, warehouse, type, date range, user |
| GET/POST | `/product-categories` | product.view / product.create |
| GET/POST | `/suppliers` | product.view / product.create |
| GET | `/inventory/alerts` | stock.view · low and out of stock |

There is **no** `PATCH /products/{id}/quantity`. Quantity changes only through `POST /stock-movements`. Any proposal to add such an endpoint must be rejected.

### 4.12 Reports
| Method | Endpoint | perm |
|---|---|---|
| GET | `/reports/attendance` | report.company / report.team |
| GET | `/reports/performance` | report.company / report.team |
| GET | `/reports/tasks` | report.company / report.team |
| GET | `/reports/goals` | report.company / report.team |
| GET | `/reports/payroll` | report.company |
| GET | `/reports/inventory` | report.company |
| GET | `/reports/stock-movements` | report.company |
| GET | `/reports/employee/{id}/monthly` | report.employee_monthly |
| POST | `/reports/{key}/export` | report.export |

Common filters: `from`, `to`, `department_id`, `employee_id`.

### 4.13 Notifications
| Method | Endpoint |
|---|---|
| GET | `/notifications` |
| GET | `/notifications/unread-count` |
| POST | `/notifications/{id}/read` |
| POST | `/notifications/read-all` |

### 4.14 Attachments
| Method | Endpoint | Notes |
|---|---|---|
| POST | `/attachments` | multipart, type + size validated |
| GET | `/attachments/{id}` | authorization-checked stream; never a public URL |
| DELETE | `/attachments/{id}` | soft delete, audited |

### 4.15 Dashboard
| Method | Endpoint | perm |
|---|---|---|
| GET | `/dashboard/admin` | report.company / report.team |
| GET | `/dashboard/employee` | authenticated |

Each returns an aggregate payload only. Widgets may also be fetched individually so one slow widget cannot block the page.

### 4.16 Audit
| Method | Endpoint | perm |
|---|---|---|
| GET | `/audit-logs` | audit.view · filters: user, entity_type, entity_id, action, date range |
| GET | `/audit-logs/entity/{type}/{id}` | audit.view |

Read-only. There is no write, update, or delete endpoint for audit logs.

## 5. Validation rules

1. Validate on the server for every endpoint, without exception. Client validation is a convenience, never a control.
2. Reject unknown fields rather than silently ignoring them.
3. Validate that every referenced id belongs to the caller's company **before** any business rule runs.
4. Enforce enum values against the documented set; reject anything else with 422.
5. Trim strings, normalise Arabic digits to Latin for numeric fields, and reject control characters.
6. Enforce maximum lengths matching the database columns.

## 6. Rate limiting

| Endpoint group | Limit |
|---|---|
| `/auth/login` | 5 per 15 min per IP + per email |
| `/auth/forgot-password` | 3 per hour per email |
| `/attendance/check-in`, `/check-out` | 10 per hour per user |
| `/attachments` | 30 per hour per user |
| General authenticated | 300 per minute per user |
| Reports and exports | 20 per hour per user |

## 7. Versioning

`/api/v1` is fixed for the lifetime of V1. Breaking changes require `/api/v2`. Additive fields are not breaking. Removing or retyping a field is.

## 8. Idempotency

`POST` endpoints that create financial or inventory records accept an `Idempotency-Key` header. Repeating a key within 24 hours returns the original result instead of creating a duplicate. Required for: payroll generation, stock movements, transfers, deductions, bonuses.
