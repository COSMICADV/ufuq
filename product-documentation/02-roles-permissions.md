# DOCUMENT 02 — USER ROLES & PERMISSIONS

## 1. Model

Three layers, evaluated in order. All three must pass.

```
1. TENANT SCOPE   — does the record belong to the caller's company?
2. ROLE / PERMISSION — does the caller's role grant this permission?
3. OWNERSHIP SCOPE  — self / team / company — which rows may they touch?
```

A caller may hold a permission and still be denied because the ownership scope does not cover the target row. `attendance.view` granted at `team` scope does not permit viewing another department's attendance.

## 2. Roles

| Role | Scope | Description |
|---|---|---|
| SUPER_ADMIN | Platform | أُفق staff. Manages companies and subscriptions. Not a company member. |
| ADMIN | Company | Full control of one company. |
| MANAGER | Team | Manages employees who report to them. |
| EMPLOYEE | Self | Own records only. |

Future roles — schema must support, V1 must not implement: HR, ACCOUNTANT, WAREHOUSE_MANAGER, SUPERVISOR.

### Design rule
Roles are **named bundles of permissions stored as data**, not hardcoded `if (role === 'ADMIN')` branches. Adding HR later must be an insert of a role row plus role_permission rows — no code change to authorization logic.

## 3. Scope values

| Scope | Meaning |
|---|---|
| `self` | Rows where `employee_id` = caller's employee id |
| `team` | Rows for employees whose `manager_id` = caller's employee id |
| `company` | All rows within the caller's company |
| `platform` | Cross-company (SUPER_ADMIN only) |

## 4. Permission catalogue

Format: `module.action`.

### Employees
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| employee.view | company | team | self |
| employee.create | ✅ | ❌ | ❌ |
| employee.update | company | ❌ | ❌ |
| employee.deactivate | ✅ | ❌ | ❌ |
| employee.view_salary | company | ❌ | self |
| employee.set_salary | ✅ | ❌ | ❌ |
| employee.assign_manager | ✅ | ❌ | ❌ |

> MANAGER cannot see team salaries in V1. This is a deliberate default. See OPEN DECISIONS OD-07.

### Attendance
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| attendance.check_in | self | self | self |
| attendance.check_out | self | self | self |
| attendance.view | company | team | self |
| attendance.update | company | ❌ | ❌ |
| attendance.request_correction | self | self | self |
| attendance.approve_correction | company | team | ❌ |

### Leave
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| leave.request | self | self | self |
| leave.view | company | team | self |
| leave.approve | company | team | ❌ |
| leave.configure_types | ✅ | ❌ | ❌ |
| leave.adjust_balance | ✅ | ❌ | ❌ |

### Tasks
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| task.view | company | team | self |
| task.create | company | team | ❌ |
| task.update | company | team | ❌ |
| task.delete | company | team | ❌ |
| task.update_status | company | team | self (assigned) |
| task.update_checklist | company | team | self (assigned) |
| task.add_progress_note | company | team | self (assigned) |

### Goals
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| goal.view | company | team | self |
| goal.create | company | team | ❌ |
| goal.update | company | team | ❌ |
| goal.update_progress | company | team | ❌ |

> Employees cannot edit their own goal progress. Sales figures and task counts are system- or manager-sourced.

### Requests
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| request.create | self | self | self |
| request.view | company | team | self |
| request.review | company | team | ❌ |
| request.cancel | self | self | self (own, pending only) |

### Payroll
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| payroll.view | company | ❌ | self |
| payroll.generate | ✅ | ❌ | ❌ |
| payroll.add_deduction | ✅ | ❌ | ❌ |
| payroll.add_bonus | ✅ | ❌ | ❌ |
| payroll.approve | ✅ | ❌ | ❌ |
| payroll.finalize | ✅ | ❌ | ❌ |
| payroll.mark_paid | ✅ | ❌ | ❌ |
| payroll.adjust | ✅ | ❌ | ❌ |

### Warehouse & inventory
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| warehouse.view | company | ❌ | ❌ |
| warehouse.manage | ✅ | ❌ | ❌ |
| product.view | company | ❌ | ❌ |
| product.create | ✅ | ❌ | ❌ |
| product.update | ✅ | ❌ | ❌ |
| stock.view | company | ❌ | ❌ |
| stock.movement_create | ✅ | ❌ | ❌ |
| stock.transfer | ✅ | ❌ | ❌ |

> V1 gives warehouse access to ADMIN only. WAREHOUSE_MANAGER is the intended future recipient.

### Reports
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| report.company | ✅ | ❌ | ❌ |
| report.team | ✅ | ✅ | ❌ |
| report.employee_monthly | company | team | self |
| report.export | ✅ | ✅ (team) | ❌ |

### Settings & audit
| Permission | ADMIN | MANAGER | EMPLOYEE |
|---|---|---|---|
| settings.view | ✅ | ❌ | ❌ |
| settings.update | ✅ | ❌ | ❌ |
| settings.work_schedule | ✅ | ❌ | ❌ |
| settings.salary_policy | ✅ | ❌ | ❌ |
| settings.performance_weights | ✅ | ❌ | ❌ |
| audit.view | ✅ | ❌ | ❌ |

## 5. Enforcement rules

1. **Every** protected endpoint declares its required permission. No endpoint is protected only by "the button isn't rendered".
2. Tenant scope is applied at the query layer (global scope / repository base filter), so a forgotten `where company_id` cannot leak data.
3. Ownership scope is resolved into a query constraint, not a post-fetch filter. Never fetch then discard.
4. Authorization failures return `403`. Records outside tenant scope return `404`, not `403` — do not confirm existence of another company's data.
5. Role and permission checks are unit-tested per endpoint (DOCUMENT 26).

## 6. Separation of Admin and Employee experiences

The two experiences are separate route trees and separate navigation, not one UI with hidden buttons.

| | Admin experience | Employee experience |
|---|---|---|
| Route root | `/admin` | `/app` |
| Navigation | 11 modules | 7 modules |
| Data default | Company-wide | Self |
| Landing | Management dashboard | Today / action dashboard |

An ADMIN who is also an employee (common in small companies) can switch to the employee experience to record their own attendance. The role does not change; the route tree and default scope do.

## 7. Role assignment rules

- Exactly one role per user in V1.
- ADMIN cannot demote or deactivate themselves if they are the last active ADMIN in the company. Server-side guard.
- SUPER_ADMIN is provisioned out-of-band. There is no UI to create one.
- Role changes are audited with old and new role.
