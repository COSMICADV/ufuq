# DOCUMENT 16 — LEAVE MANAGEMENT SPECIFICATION

## PURPOSE
Track leave entitlement per employee, process leave requests through approval, keep balances accurate, and write the resulting attendance records so payroll stays correct without double entry.

## USERS
| User | Interaction |
|---|---|
| EMPLOYEE | Views balance, submits requests, cancels pending requests |
| MANAGER | Approves or rejects team requests |
| ADMIN | Configures leave types and allowances, approves any request, adjusts balances |

## DATA
**leave_types:** name, is_paid, default_days_per_year, requires_attachment, allows_negative_balance, carry_over_policy, carry_over_cap.
**leave_balances:** employee_id, leave_type_id, year, total_days, used_days, pending_days, carried_over_days.
**leave_requests:** employee_id, leave_type_id, start_date, end_date, days_count, reason, attachment_id, status, reviewed_by, reviewed_at, review_note.

**Remaining is computed, never stored:**
```
remaining = total_days + carried_over_days − used_days − pending_days
```

**Leave types (seeded, fully configurable):** Annual · Sick · Emergency · Unpaid · Other.

## SCREENS
Employee: `/app/requests/new` (leave category) · `/app/requests` · `/app/requests/:id` · balance card on `/app`
Admin: `/admin/requests` filtered to leave · request detail · employee profile leave section
Settings: `/admin/settings/leave-types`

## ACTIONS
| Actor | Action |
|---|---|
| Employee | View balance · Submit request · Cancel own pending request · View history |
| Manager | View team requests · Approve · Reject with reason |
| Admin | All of the above company-wide · Configure types and allowances · Adjust balances with reason |

## BUSINESS RULES

1. **Balance is per employee, per leave type, per year.**
2. **Duration is calculated by the system**, excluding weekends and holidays according to the employee's work schedule. The employee never types the day count.
3. **Pending requests hold days softly.** Submitting reserves days in `pending_days`; approval moves them to `used_days`; rejection or cancellation releases them. This prevents an employee from over-committing an unapproved balance.
4. **Approval is transactional:** deduct balance + release hold + create attendance records with status `on_leave` + update request status — all or nothing.
5. **Approved leave writes attendance records** linked back to the leave request. This is the mechanism that keeps payroll correct.
6. **Insufficient balance blocks the request**, unless the leave type has `allows_negative_balance`, in which case excess days are treated as unpaid and the employee is warned before submitting.
7. **Unpaid leave** does not consume a paid balance and produces an attendance-based deduction in payroll per the salary policy.
8. **Rejection requires a reason.**
9. **Attachment requirement** is per leave type (typically sick leave). Enforced server-side.
10. **Overlapping approved leave is blocked**, with the conflicting dates listed.
11. **Leave overlapping an existing attendance record** with a check-in is blocked — the employee was evidently at work.
12. **Leave in a finalized payroll period cannot be approved.** Directed to the payroll adjustment flow.
13. **Carry-over** runs as an annual job per the type's policy: none, full, or capped.
14. **Balance adjustments by an admin** require a reason and are audited with old and new values.
15. **Employees cancel only their own pending requests.** Approved leave is cancelled by an admin. Approved leave cancellation reverses the balance and reconciles the system-generated attendance records back to their correct non-leave state. Attendance records are never hard-deleted. All of it is audited after the cancellation commits.

### Example
```
Annual Leave
Total:      14 days
Used:        6 days
Remaining:   8 days
```

## PERMISSIONS
`leave.request` (self) · `leave.view` (company/team/self) · `leave.approve` (company/team) · `leave.configure_types` · `leave.adjust_balance`.

## API REQUIREMENTS
The `/leave-requests` and `/leave-balances` sets per DOCUMENT 08 §4.6, including `GET /leave-requests/calculate` which returns the working-day count for a proposed range so the UI can show it live.

## DATABASE REQUIREMENTS
Unique `(employee_id, leave_type_id, year)` on balances. Indexes on `(company_id, status)` and `(employee_id, start_date)` for requests. Foreign key from `attendance_records.leave_request_id`. Soft delete on leave types.

## VALIDATION
- `end_date ≥ start_date`.
- Calculated `days_count` > 0 — a range consisting entirely of weekends is rejected with an explanation.
- Requested days ≤ remaining, unless the type allows negative.
- Attachment present when the type requires it.
- Reason required, minimum 3 characters.
- Start date not before the joining date.
- Rejection reason required.
- Balance adjustment reason required.

## ERROR STATES
| Situation | Handling |
|---|---|
| Insufficient balance | "رصيدك المتبقي ٣ أيام والطلب ٥ أيام" with the option to submit the excess as unpaid if the type allows |
| Overlapping leave | Blocked, with the conflicting request and its dates shown |
| All-weekend range | "النطاق المحدد لا يحتوي على أيام عمل" |
| Missing required attachment | Blocked at field level |
| Period finalized | "تم إنهاء كشف رواتب هذه الفترة" |
| Attendance already recorded | Blocked, showing the recorded check-in |

## EDGE CASES
| Case | Handling |
|---|---|
| Leave spanning two months | Days split correctly across both payroll periods; each period counts only its own days |
| Leave spanning two years | Split at the year boundary; each year's balance is charged its portion |
| Holiday declared inside approved leave | Day count is **not** silently recalculated. The admin is shown the affected requests and confirms explicitly |
| Half-day leave | Not supported in V1 — flagged as OD-11 |
| Employee joins mid-year | Allowance pro-rated per company policy (configurable) |
| Employee terminated with unused balance | Encashment is out of V1 scope (OD-08) |
| Retroactive leave request | Allowed within a configurable window; blocked if the period is finalized |
| Approved leave cancelled | Approved leave cancellation reverses the balance and reconciles the system-generated attendance records back to their correct non-leave state. Attendance records are never hard-deleted. A past working day becomes `absent`; a holiday or rest day takes its calendar status; today or a later working day becomes `pending` until it is checked into or ends (DOCUMENT 12). Real check-in/check-out data is never overwritten. All audited after commit. Blocked if the period is finalized |
| Two approvers act simultaneously | Optimistic locking; the second receives 409 with the current status |
| Carry-over exceeding the cap | Excess is forfeited and the forfeiture is recorded in the audit log |

## MOBILE BEHAVIOUR
- The balance card sits on the employee dashboard, showing remaining days per type.
- The request form uses native date pickers with a live day-count as dates change.
- The balance is displayed above the form so the employee sees the impact before submitting.
- Attachment upload uses the native camera for sick notes.
- Approval is comfortable on mobile for managers — the request detail and decision buttons are a single scrollable screen.

## FUTURE EXTENSIONS
Half-day and hourly leave, a team leave calendar with overlap warnings, multi-level approval chains, leave encashment, automatic accrual by month worked, public-holiday calendars by region, delegation during absence, and leave policies differing by seniority. None in V1.
