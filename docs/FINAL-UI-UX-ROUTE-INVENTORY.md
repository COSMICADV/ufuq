# UFUQ route inventory before redesign

Baseline: `d1f70f2` (clean). Inventory created before visual changes. All existing page modules, data loaders, guards and actions remain in place.

| Route pattern                                       | Source                                                                       | Presentation coverage                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `/[locale]/[publicPage]`                            | `apps/web/src/app/[locale]/[publicPage]/page.tsx`                            | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/accept-invitation`                       | `apps/web/src/app/[locale]/accept-invitation/page.tsx`                       | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/attendance/corrections`            | `apps/web/src/app/[locale]/admin/attendance/corrections/page.tsx`            | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/attendance/monthly`                | `apps/web/src/app/[locale]/admin/attendance/monthly/page.tsx`                | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/attendance`                        | `apps/web/src/app/[locale]/admin/attendance/page.tsx`                        | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/employees/[id]/[tab]`              | `apps/web/src/app/[locale]/admin/employees/[id]/[tab]/page.tsx`              | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/employees/[id]/edit`               | `apps/web/src/app/[locale]/admin/employees/[id]/edit/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/employees/[id]`                    | `apps/web/src/app/[locale]/admin/employees/[id]/page.tsx`                    | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/employees/new`                     | `apps/web/src/app/[locale]/admin/employees/new/page.tsx`                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/employees`                         | `apps/web/src/app/[locale]/admin/employees/page.tsx`                         | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/goals/[id]`                        | `apps/web/src/app/[locale]/admin/goals/[id]/page.tsx`                        | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/goals/new`                         | `apps/web/src/app/[locale]/admin/goals/new/page.tsx`                         | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/goals`                             | `apps/web/src/app/[locale]/admin/goals/page.tsx`                             | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory/[productId]/movements`   | `apps/web/src/app/[locale]/admin/inventory/[productId]/movements/page.tsx`   | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory/[productId]`             | `apps/web/src/app/[locale]/admin/inventory/[productId]/page.tsx`             | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory/movements`               | `apps/web/src/app/[locale]/admin/inventory/movements/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory/new`                     | `apps/web/src/app/[locale]/admin/inventory/new/page.tsx`                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory`                         | `apps/web/src/app/[locale]/admin/inventory/page.tsx`                         | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/inventory/suppliers`               | `apps/web/src/app/[locale]/admin/inventory/suppliers/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/notifications`                     | `apps/web/src/app/[locale]/admin/notifications/page.tsx`                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin`                                   | `apps/web/src/app/[locale]/admin/page.tsx`                                   | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/payroll/[periodId]/[employeeId]`   | `apps/web/src/app/[locale]/admin/payroll/[periodId]/[employeeId]/page.tsx`   | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/payroll/[periodId]`                | `apps/web/src/app/[locale]/admin/payroll/[periodId]/page.tsx`                | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/payroll`                           | `apps/web/src/app/[locale]/admin/payroll/page.tsx`                           | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/reports/[reportKey]`               | `apps/web/src/app/[locale]/admin/reports/[reportKey]/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/reports`                           | `apps/web/src/app/[locale]/admin/reports/page.tsx`                           | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/requests/[id]`                     | `apps/web/src/app/[locale]/admin/requests/[id]/page.tsx`                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/requests`                          | `apps/web/src/app/[locale]/admin/requests/page.tsx`                          | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/audit-log`                | `apps/web/src/app/[locale]/admin/settings/audit-log/page.tsx`                | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/company`                  | `apps/web/src/app/[locale]/admin/settings/company/page.tsx`                  | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/departments`              | `apps/web/src/app/[locale]/admin/settings/departments/page.tsx`              | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/leave-types`              | `apps/web/src/app/[locale]/admin/settings/leave-types/page.tsx`              | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/notifications`            | `apps/web/src/app/[locale]/admin/settings/notifications/page.tsx`            | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/performance`              | `apps/web/src/app/[locale]/admin/settings/performance/page.tsx`              | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/positions`                | `apps/web/src/app/[locale]/admin/settings/positions/page.tsx`                | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/salary-policy`            | `apps/web/src/app/[locale]/admin/settings/salary-policy/page.tsx`            | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/settings/schedules`                | `apps/web/src/app/[locale]/admin/settings/schedules/page.tsx`                | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/tasks/[id]`                        | `apps/web/src/app/[locale]/admin/tasks/[id]/page.tsx`                        | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/tasks/new`                         | `apps/web/src/app/[locale]/admin/tasks/new/page.tsx`                         | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/tasks`                             | `apps/web/src/app/[locale]/admin/tasks/page.tsx`                             | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/warehouse/locations/[warehouseId]` | `apps/web/src/app/[locale]/admin/warehouse/locations/[warehouseId]/page.tsx` | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/warehouse/locations`               | `apps/web/src/app/[locale]/admin/warehouse/locations/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/warehouse`                         | `apps/web/src/app/[locale]/admin/warehouse/page.tsx`                         | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/admin/warehouse/transfers`               | `apps/web/src/app/[locale]/admin/warehouse/transfers/page.tsx`               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/attendance/correction/new`           | `apps/web/src/app/[locale]/app/attendance/correction/new/page.tsx`           | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/attendance/history`                  | `apps/web/src/app/[locale]/app/attendance/history/page.tsx`                  | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/attendance`                          | `apps/web/src/app/[locale]/app/attendance/page.tsx`                          | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/goals/[id]`                          | `apps/web/src/app/[locale]/app/goals/[id]/page.tsx`                          | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/goals`                               | `apps/web/src/app/[locale]/app/goals/page.tsx`                               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/notifications`                       | `apps/web/src/app/[locale]/app/notifications/page.tsx`                       | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app`                                     | `apps/web/src/app/[locale]/app/page.tsx`                                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/reports/[month]`                     | `apps/web/src/app/[locale]/app/reports/[month]/page.tsx`                     | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/reports`                             | `apps/web/src/app/[locale]/app/reports/page.tsx`                             | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/requests/[id]`                       | `apps/web/src/app/[locale]/app/requests/[id]/page.tsx`                       | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/requests/new`                        | `apps/web/src/app/[locale]/app/requests/new/page.tsx`                        | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/requests`                            | `apps/web/src/app/[locale]/app/requests/page.tsx`                            | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/salary/[periodId]`                   | `apps/web/src/app/[locale]/app/salary/[periodId]/page.tsx`                   | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/salary/history`                      | `apps/web/src/app/[locale]/app/salary/history/page.tsx`                      | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/salary`                              | `apps/web/src/app/[locale]/app/salary/page.tsx`                              | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/tasks/[id]`                          | `apps/web/src/app/[locale]/app/tasks/[id]/page.tsx`                          | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/app/tasks`                               | `apps/web/src/app/[locale]/app/tasks/page.tsx`                               | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]/login`                                   | `apps/web/src/app/[locale]/login/page.tsx`                                   | Shared V2 tokens, controls, layout and module patterns |
| `/[locale]`                                         | `apps/web/src/app/[locale]/page.tsx`                                         | Shared V2 tokens, controls, layout and module patterns |

Dynamic public pages: home, about, features, for-companies, for-individuals, pricing, contact, login, register. Arabic marketing paths are unprefixed; English uses `/en`.

Additional surfaces: invitation acceptance; localized not-found; password-reset mode on login; employee profile tabs (including leave balances, salary, audit and reports); request type selection and leave request/review; checklist controls inside task details; stock receive/issue/adjust and transfer dialogs; notification feed and preferences; payroll details and employee salary history; report catalogue keys and monthly report tabs.

Leave is an integrated employee-profile, dashboard and request flow, not an independent route. Native `apps/mobile` is a component catalogue, not a second implemented ERP: keep that existing scope and refresh shared/native styling.
