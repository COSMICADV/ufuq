# أُفق ERP — Product & Technical Documentation

**Product:** أُفق (Ufuq)
**Version:** Documentation Package v1.0
**Status:** Awaiting approval — development has NOT started
**Prepared by:** Product Architecture / ERP Architecture / UX Architecture / Database Architecture / Technical Documentation

> This package is the single source of truth for the أُفق ERP platform. No code exists yet and no code should be written until this documentation is approved.

---

## 1. Executive Summary

أُفق is an Arabic-first ERP platform that connects company management and employee operations into one system. Version 1 targets **companies**; an **individual** edition is planned for a later release.

The product's differentiator is not feature count. It is the **connection between modules**: attendance feeds payroll, tasks feed performance, goals feed monthly reports, and inventory movements feed warehouse valuation — with a single audit trail across all of them.

V1 covers eleven functional areas: Dashboard, Employees, Attendance, Tasks, Goals, Requests, Payroll, Reports, Warehouse, Inventory, Settings. Plus a public marketing website.

Three commitments shape every decision in this package:

1. **Financial integrity.** Payroll and stock are append-and-adjust, never silently overwritten.
2. **Company isolation.** Multi-tenant from the first migration, enforced server-side.
3. **Arabic-first.** RTL is the default layout direction, not a translation layer added later.

## 2. Product Vision
→ [DOCUMENT 01 — Product Requirements](01-PRD.md)

## 3. Core Users
→ [DOCUMENT 02 — User Roles & Permissions](02-roles-permissions.md)

## 4. Functional Requirements
→ [DOCUMENT 01 §4](01-PRD.md)

## 5. Non-Functional Requirements
→ [DOCUMENT 01 §5](01-PRD.md)

## 6. Information Architecture
→ [DOCUMENT 03](03-information-architecture.md)

## 7. Screen Inventory
→ [DOCUMENT 04](04-screen-inventory.md)

## 8. User Flows
→ [DOCUMENT 05](05-user-flows.md)

## 9. Database Architecture
→ [DOCUMENT 06](06-database-architecture.md) · [DOCUMENT 07 — ERD](07-erd.md)

## 10. API Architecture
→ [DOCUMENT 08](08-api-architecture.md)

## 11. Authentication
→ [DOCUMENT 09](09-auth.md)

## 12. Permissions
→ [DOCUMENT 02](02-roles-permissions.md) · [DOCUMENT 09](09-auth.md)

## 13. Design System
→ [DOCUMENT 10](10-design-system.md)

## 14. UI/UX
→ [DOCUMENT 11](11-uiux-specification.md)

## 15. Module Specifications
→ [DOCUMENT 12 — Attendance](12-attendance-spec.md)
→ [DOCUMENT 13 — Tasks & Checklists](13-tasks-spec.md)
→ [DOCUMENT 14 — Goals & Performance](14-goals-performance-spec.md)
→ [DOCUMENT 15 — Salary & Payroll](15-payroll-spec.md)
→ [DOCUMENT 16 — Leave Management](16-leave-spec.md)
→ [DOCUMENT 17 — Warehouse & Inventory](17-warehouse-inventory-spec.md)

## 16. Security
→ [DOCUMENT 20](20-security-spec.md)

## 17. Audit System
→ [DOCUMENT 21](21-audit-logging-spec.md)

## 18. Reporting
→ [DOCUMENT 18](18-reporting-spec.md) · [DOCUMENT 19 — Notifications](19-notification-spec.md)

## 19. MVP Scope
→ [DOCUMENT 24](24-mvp-scope.md)

## 20. Development Roadmap
→ [DOCUMENT 25](25-development-roadmap.md)

## 21. Testing Strategy
→ [DOCUMENT 26](26-testing-strategy.md)

## 22. Claude Development Rules
→ [DOCUMENT 27](27-claude-development-rules.md)

## 23. Open Decisions
→ [OPEN DECISIONS](28-open-decisions.md)

---

## Supporting documents

- [DOCUMENT 22 — Responsive Design](22-responsive-spec.md)
- [DOCUMENT 23 — Public Website](23-public-website-spec.md)

---

## Document map

| # | Document | Primary audience |
|---|---|---|
| 01 | Product Requirements | Everyone |
| 02 | User Roles & Permissions | Backend, Security |
| 03 | Information Architecture | UX, Frontend |
| 04 | Screen Inventory | UX, UI, Frontend |
| 05 | User Flows | UX, QA |
| 06 | Database Architecture | Backend, DBA |
| 07 | ERD | Backend, DBA |
| 08 | API Architecture | Backend, Frontend |
| 09 | Authentication & Authorization | Backend, Security |
| 10 | Design System | UI, Frontend |
| 11 | UI/UX Specification | UX, Frontend |
| 12–17 | Module Specifications | Backend, Frontend, QA |
| 18 | Reporting | Backend, Frontend |
| 19 | Notifications | Backend |
| 20 | Security | Security, Backend |
| 21 | Audit Logging | Backend, Compliance |
| 22 | Responsive Design | UI, Frontend |
| 23 | Public Website | Marketing, Frontend |
| 24 | MVP Scope | Product |
| 25 | Development Roadmap | Product, Engineering |
| 26 | Testing Strategy | QA |
| 27 | Claude Development Rules | AI coding sessions |
| 28 | Open Decisions | Product owner |

---

## How to use this package with Claude

1. Approve or amend [OPEN DECISIONS](28-open-decisions.md) first. Several are blocking.
2. Before any coding session, load [DOCUMENT 27](27-claude-development-rules.md) plus the specific module spec being implemented.
3. Follow the phase order in [DOCUMENT 25](25-development-roadmap.md). Do not jump phases.
4. Any architectural deviation must be raised as `[DECISION REQUIRED]` before implementation, not after.
