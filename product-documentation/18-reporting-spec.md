# DOCUMENT 18 — REPORTING SPECIFICATION

## PURPOSE
Turn operational data into decisions. Reports read from the same records the modules write; they never maintain a parallel truth.

## USERS
ADMIN — all company reports. MANAGER — team-scoped reports. EMPLOYEE — own monthly report only.

## COMPANY REPORTS

| Report | Contents | V1 |
|---|---|---|
| Attendance | Present, absent, late, WFH, office, leave by employee and department over a date range; trend chart | ✅ |
| Employee performance | Attendance, task, goal, and overall scores per employee; department comparison | ✅ |
| Task | Assigned, completed, in progress, overdue, on-time rate by employee and department | ✅ |
| Goal | Goal progress by employee, type, and period; achievement rate | ✅ |
| Payroll | Gross, deductions, bonuses, net by employee and period; month-over-month comparison | ✅ |
| Inventory | Stock on hand, value by product/category/location, low and out of stock | ✅ |
| Warehouse | Value and movement volume by location, activity over time | ✅ |
| Stock movement | Full movement ledger with filters | ✅ |

## EMPLOYEE REPORTS

| Report | Contents | V1 |
|---|---|---|
| Monthly attendance | Working days, present, WFH, late, absent, leave | ✅ |
| Monthly tasks | Assigned, completed, in progress, overdue | ✅ |
| Monthly goals | Progress per goal at month end | ✅ |
| Monthly salary | Base, deductions, bonuses, net | ✅ |
| Performance summary | Component and overall scores | ✅ |

### Monthly report structure (per DOCUMENT 05 FLOW 19)

```
سبتمبر ٢٠٢٦

الحضور        أيام العمل ٢٦ · حضور ٢٣ · عن بُعد ٨ · تأخير ٢ · غياب ١ · إجازة ٢
المهام        مسندة ٢٠ · مكتملة ١٧ · قيد التنفيذ ٢ · متأخرة ١
الأهداف       هدف المبيعات ٨٧٪ · هدف المهام ٩٢٪
الراتب        الأساسي ٢٠٬٠٠٠ · خصومات ٥٠٠ · مكافآت ١٬٠٠٠ · الصافي ٢٠٬٥٠٠
الأداء        الحضور ٩٢٪ · المهام ٨٥٪ · الأهداف ٩٠٪ · الإجمالي ٨٩٪
```

The performance figures come from the configured weights (DOCUMENT 14), and the weights in effect are stored in the report snapshot.

## BUSINESS RULES

1. **Monthly reports are snapshots**, generated on the 1st of each month or on demand, and persisted. Later edits to historical data do not silently rewrite a generated report.
2. **Regeneration is explicit and audited**, and the report shows both its generation date and a flag if the underlying data has changed since.
3. **A report covering an unfinalized payroll period is marked provisional.**
4. **Report permissions follow ownership scope.** A manager's "company" report is silently scoped to their team, and the scope is stated on the report itself so the numbers are not misread.
5. **Reports are read-only.** No report screen ever writes data.
6. **Large reports are paginated or streamed.** No report loads an unbounded result set into memory or into the browser.
7. **Filters are stated on the output**, including in exports, so a printed report is self-describing.

## FILTERS
Common: date range · department · employee · status.
Module-specific: work mode (attendance) · priority (tasks) · goal type · movement type · warehouse · product category.

Default range is the current month. Ranges longer than 12 months require confirmation.

## EXPORT & PRINT

| Capability | V1 |
|---|---|
| CSV export | ✅ |
| Excel export | Should have |
| PDF export | Nice to have |
| Print stylesheet | ✅ |
| Scheduled email delivery | Future |

Exports respect the caller's permissions and scope. An export never contains rows the user could not see on screen. Every export is audited with the report key and filters used.

## API REQUIREMENTS
The `/reports` set per DOCUMENT 08 §4.12. Report endpoints are rate limited (20/hour/user) because they are expensive.

## DATABASE REQUIREMENTS
Reports read from existing tables plus the `monthly_employee_reports` snapshot table. Where a dashboard aggregation is measured to be slow, a summary table may be introduced — but only with a documented rebuild job, never as a second source of truth.

## PERFORMANCE
- Reports run on indexed, tenant-scoped queries.
- Aggregations happen in the database, not in application code looping over rows.
- Long-running exports run as background jobs with a completion notification.
- Every report has a documented expected row count and a tested worst case.

## ERROR STATES
| Situation | Handling |
|---|---|
| No data for the filters | "لا توجد بيانات في النطاق المحدد" with a suggestion to widen the range |
| Range too large | Confirmation before running |
| Export fails | Toast plus a notification, with the failure reason and a retry action |
| Timeout | Automatically converted to a background job rather than failing |

## MOBILE BEHAVIOUR
Filters in a bottom sheet. Charts stack full width. Tables scroll horizontally with a frozen first column. Export triggers the native share sheet. Employees' monthly reports are fully mobile-optimised, since that is where they will read them.

## FUTURE EXTENSIONS
Custom report builder, saved report configurations, scheduled email delivery, dashboard widget customisation, cross-period comparison views, department-level rollups, drill-down from chart to record, and data warehouse export. None in V1.
