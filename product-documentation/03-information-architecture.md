# DOCUMENT 03 — INFORMATION ARCHITECTURE

## 1. Top-level structure

```
أُفق
├── Public website          (unauthenticated)
├── Auth                    (login, reset, invitation acceptance)
├── Admin experience        /admin
├── Employee experience     /app
└── Platform console        /platform   (SUPER_ADMIN, minimal in V1)
```

## 2. Admin navigation

Primary sidebar, in order. Arabic labels are canonical.

| # | العربية | English | Route |
|---|---|---|---|
| 1 | الرئيسية | Dashboard | `/admin` |
| 2 | الموظفون | Employees | `/admin/employees` |
| 3 | الحضور والانصراف | Attendance | `/admin/attendance` |
| 4 | المهام | Tasks | `/admin/tasks` |
| 5 | الأهداف | Goals | `/admin/goals` |
| 6 | الطلبات | Requests | `/admin/requests` |
| 7 | الرواتب | Payroll | `/admin/payroll` |
| 8 | التقارير | Reports | `/admin/reports` |
| 9 | المخزن | Warehouse | `/admin/warehouse` |
| 10 | المخزون | Inventory | `/admin/inventory` |
| 11 | الإعدادات | Settings | `/admin/settings` |

### Warehouse vs Inventory
These are distinct on purpose and must not be merged.

- **المخزن / Warehouse** = the *places*. Locations, their configuration, per-location stock levels, transfers between them, warehouse-level dashboard and valuation.
- **المخزون / Inventory** = the *things*. Product catalogue, SKUs, categories, suppliers, pricing, and stock movement history per product.

## 3. Admin route tree

```
/admin
├── /                                  Dashboard
├── /employees
│   ├── /                              List
│   ├── /new                           Create
│   └── /:id
│       ├── /                          Overview tab
│       ├── /attendance
│       ├── /tasks
│       ├── /goals
│       ├── /salary
│       ├── /requests
│       ├── /reports
│       └── /edit
├── /attendance
│   ├── /                              Daily board
│   ├── /monthly                       Monthly matrix
│   ├── /corrections                   Correction requests
│   └── /:employeeId/:date             Record detail
├── /tasks
│   ├── /                              List / board
│   ├── /new
│   └── /:id
├── /goals
│   ├── /
│   ├── /new
│   └── /:id
├── /requests
│   ├── /                              Unified inbox
│   └── /:id
├── /payroll
│   ├── /                              Period list
│   ├── /:periodId                     Payroll run
│   └── /:periodId/:employeeId         Payslip detail
├── /reports
│   ├── /                              Report catalogue
│   └── /:reportKey                    Report viewer
├── /warehouse
│   ├── /                              Warehouse dashboard
│   ├── /locations
│   ├── /locations/:id
│   └── /transfers
├── /inventory
│   ├── /                              Product list
│   ├── /new
│   ├── /:id                           Product detail
│   ├── /:id/movements                 Movement history
│   ├── /movements                     All movements
│   └── /suppliers
└── /settings
    ├── /company
    ├── /departments
    ├── /positions
    ├── /schedules
    ├── /leave-types
    ├── /salary-policy
    ├── /performance
    ├── /roles
    ├── /notifications
    └── /audit-log
```

## 4. Employee navigation

| # | العربية | English | Route |
|---|---|---|---|
| 1 | الرئيسية | Home | `/app` |
| 2 | الحضور | Attendance | `/app/attendance` |
| 3 | مهامي | My Tasks | `/app/tasks` |
| 4 | أهدافي | My Goals | `/app/goals` |
| 5 | طلباتي | My Requests | `/app/requests` |
| 6 | راتبي | My Salary | `/app/salary` |
| 7 | ملفي | My Profile | `/app/profile` |

```
/app
├── /                          Today dashboard
├── /attendance
│   ├── /                      Today + quick actions
│   ├── /history
│   └── /correction/new
├── /tasks
│   ├── /                      My tasks
│   └── /:id                   Task detail + checklist
├── /goals
│   └── /:id
├── /requests
│   ├── /
│   ├── /new
│   └── /:id
├── /salary
│   ├── /                      Current month
│   ├── /history
│   └── /:periodId             Payslip
├── /reports/:month            My monthly report
├── /notifications
└── /profile
```

## 5. Public website

```
/
├── /                    Home
├── /about               About أُفق
├── /features            Features
├── /for-companies       For Companies
├── /for-individuals     For Individuals
├── /pricing             Pricing
├── /contact             Contact
├── /login               Login
└── /register            Register
```

## 6. Navigation behaviour

- Sidebar is expanded on desktop, icon-only (collapsible) on laptop and tablet, and replaced by a bottom tab bar on mobile for the employee experience.
- In RTL the sidebar is on the **right**. In LTR it moves to the left. This is a layout-direction consequence, not two separate layouts.
- Breadcrumbs appear on all pages below the top level: `الرئيسية / المبيعات` reads right-to-left.
- Active state uses the primary green pill on the deep-green sidebar.

## 7. Content hierarchy per page

Every module page follows the same skeleton:

```
Page title + breadcrumb
KPI / summary strip           (optional, module-dependent)
Primary action                (top-inline, e.g. + موظف جديد)
Filter + search bar
Data surface                  (table / board / cards)
Pagination
```

Deviating from this skeleton requires a documented reason.

## 8. Global elements

| Element | Placement | Present in |
|---|---|---|
| Logo أُفق | Sidebar top | Admin, Employee |
| Global search | Header, opposite side from notifications | Admin (V1: scoped search only) |
| Notifications bell | Header | Admin, Employee |
| User menu | Sidebar bottom (admin), header (employee) | Both |
| Language switch | User menu | Both |

## 9. Naming rules

- Arabic labels are the source of truth. English labels are the documented equivalents in the table above.
- Route segments are English, lowercase, kebab-case, and never localized.
- Do not invent new navigation entries. Adding a top-level item requires product approval.
