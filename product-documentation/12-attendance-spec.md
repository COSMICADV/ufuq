# DOCUMENT 12 — ATTENDANCE SPECIFICATION

## PURPOSE
Record when and how each employee works, and feed that record into payroll, performance, and reporting. Attendance is the module the whole system depends on: if attendance is wrong, payroll is wrong.

## USERS
| User | Interaction |
|---|---|
| EMPLOYEE | Checks in and out, selects work mode, views own history, requests corrections |
| MANAGER | Views team attendance, approves team corrections |
| ADMIN | Views all attendance, adjusts records, approves corrections, configures schedules |

## DATA

**attendance_records:** company_id, employee_id, date, work_mode, check_in_at, check_out_at, working_minutes, overtime_minutes, late_minutes, status, source, leave_request_id, note, created_by.

**Work mode** — `office` or `wfh`. A first-class column, not a note. OFFICE means the company's physical location. WFH means working remotely. Both count as attendance; the distinction exists for reporting, policy, and (potentially) different allowance rules later.

**Status values:** present · absent · late · on_leave · half_day · holiday · weekend · pending.

`office` and `wfh` are *modes*, not statuses. A record is `present` with mode `wfh`. Storing "WFH" as a status would make it impossible to ask "how many present days were remote?"

**Source values:** `self` (employee action) · `admin` (manual entry) · `correction` (approved correction) · `system` (generated from leave, holiday, or absence job).

**work_schedules / work_schedule_days:** the configurable schedule. Working days, start and end times, grace period, break minutes, half-day threshold, overtime policy.

**holidays:** company-level dates excluded from working days.

## SCREENS
- Employee: dashboard attendance card · `/app/attendance` · `/app/attendance/history` · `/app/attendance/correction/new`
- Admin: `/admin/attendance` daily board · `/admin/attendance/monthly` matrix · `/admin/attendance/corrections` · record detail
- Settings: `/admin/settings/schedules`

## ACTIONS
| Actor | Action |
|---|---|
| Employee | Check in (office/wfh) · Check out · View today · View history · View monthly summary · Request correction · Cancel own pending correction |
| Manager | View team attendance · Approve/reject team corrections |
| Admin | All of the above company-wide · Manually adjust records · Configure schedules · Configure holidays |

## BUSINESS RULES

1. **One record per employee per day.** Enforced by a unique constraint on `(employee_id, date)`.
2. **Work mode is required on check-in.** There is no default. The employee chooses OFFICE or WFH explicitly.
3. **Working days come from the schedule, never from code.** Saturday–Thursday 09:00–17:00 is a seed example only.
4. **Lateness** = `check_in_at > scheduled_start + grace_period`. Recorded in `late_minutes` and sets status to `late`. Grace period is configurable per schedule.
5. **Working minutes** = `check_out_at − check_in_at − unpaid break minutes`.
6. **Overtime** = `max(0, working_minutes − scheduled_minutes)`, subject to the schedule's overtime policy (`none`, `paid`, `banked`).
7. **Half day** applies when working minutes fall below the configured half-day threshold.
8. **Approved leave writes attendance records** with status `on_leave` and `source = system`, linked to the leave request.
9. **Weekends and holidays** are generated as records with the corresponding status so that monthly views and payroll calculations are complete.
10. **Absence is derived by a nightly job**: any working day with no record and no approved leave becomes `absent` with `source = system`.
11. **Every admin adjustment is audited** with old and new values and a required reason.
12. **Attendance in a finalized payroll period cannot be changed.** The correction flow blocks and directs to the payroll adjustment flow.
13. **Corrections have a window**, default 7 days, configurable per company.
14. Check-out without check-in is impossible through the normal flow; the employee is directed to a correction request.

## PERMISSIONS
`attendance.check_in` / `check_out` (self) · `attendance.view` (company/team/self) · `attendance.update` (admin only) · `attendance.request_correction` (self) · `attendance.approve_correction` (company/team).

## API REQUIREMENTS
`POST /attendance/check-in` · `POST /attendance/check-out` · `GET /attendance/today` · `GET /attendance` · `GET /attendance/monthly` · `PATCH /attendance/{id}` · `GET /attendance/summary` · the `/attendance-corrections` set. Full definitions in DOCUMENT 08 §4.4–4.5.

## DATABASE REQUIREMENTS
Unique `(employee_id, date)`. Indexes on `(company_id, date)`, `(employee_id, date)`, `(company_id, status, date)`. Foreign keys to employees, leave_requests, users. Never hard-deleted.

## VALIDATION
- `work_mode` ∈ {office, wfh} on check-in.
- Check-in blocked if an open record already exists for today → 409 with the existing check-in time.
- Check-out blocked if no open record exists → 409 with a link to the correction flow.
- Correction dates must be in the past and within the correction window.
- Correction `requested_check_out` must be after `requested_check_in`.
- Rejection requires a reason.
- Manual admin adjustment requires a reason.

## ERROR STATES
| Situation | Message |
|---|---|
| Already checked in | "سجلت حضورك بالفعل اليوم في ٠٨:٥٧ ص" |
| No check-in on check-out | "لا يوجد تسجيل حضور اليوم. يمكنك تقديم طلب تصحيح." |
| Non-working day | Confirmation dialog: "اليوم يوم راحة. هل تريد تسجيل الحضور؟" |
| Outside correction window | "انتهت مهلة التصحيح لهذا التاريخ. تواصل مع الإدارة." |
| Period finalized | "تم إنهاء كشف رواتب هذا الشهر ولا يمكن تعديل الحضور. استخدم تسوية الرواتب." |
| Load failure | Attendance card shows an error and buttons are disabled — never render an action whose result is unknown |

## EDGE CASES

| Case | Handling |
|---|---|
| Overnight shift (check-out next day) | Record belongs to the check-in date. Schedule flags overnight support. Documented as OD-05 for V1 scope |
| Employee forgets to check out | Nightly job closes the record at scheduled end time, marks it `pending`, and notifies the employee to submit a correction |
| Employee joins mid-month | Working days count only from the joining date |
| Employee terminated mid-month | Working days count only to the termination date |
| Schedule changes mid-month | Each day is evaluated against the schedule in effect on that date, not the current one |
| Holiday added retroactively | Existing records are not silently rewritten. The admin is shown which records would change and confirms explicitly, and the change is audited |
| Leave approved for past dates | Existing records for those dates are updated to `on_leave` and audited. Blocked if payroll is finalized |
| Approved leave cancelled | Its records are kept and reconciled in place, never deleted (DOCUMENT 16 rule 15). A past working day becomes `absent`, and a holiday or rest day takes its calendar status. Today or a later working day becomes `pending` with no check-in (`source = system`). Checking in converts that row. If nobody checks in, the nightly job turns it into `absent` once the day has ended |
| Two devices check in simultaneously | Unique constraint plus a transaction makes the second attempt a clean 409, not a duplicate |
| Timezone | All calculations use the company timezone. The browser timezone is never trusted |
| Clock skew | Server time is authoritative. Client-supplied timestamps are ignored |

## MOBILE BEHAVIOUR
This is the most-used mobile screen in the product.
- The attendance card sits above the fold, full width.
- OFFICE and WFH are two large buttons, minimum 56px tall, side by side.
- After check-in the card shows a live-updating duration.
- Check-out is a single full-width button.
- History uses a month calendar with colour-coded days, tappable for detail.
- Correction requests use a mobile-optimised form with native date and time pickers.
- The check-in action works on a slow connection: optimistic UI with a clear pending indicator and rollback on failure.

## FUTURE EXTENSIONS
Not in V1, but the architecture must not preclude them: geofenced check-in, biometric or device-bound attendance, shift patterns and rotating rosters, multiple check-in/out pairs per day for split shifts, overtime approval workflow, attendance-based allowances, and integration with physical access-control hardware.
