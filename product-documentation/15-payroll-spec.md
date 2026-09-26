# DOCUMENT 15 — SALARY & PAYROLL SPECIFICATION

## PURPOSE
Turn attendance into pay, with a configurable calculation engine, a reviewable approval chain, and financial records that cannot be silently rewritten.

This is the highest-risk module in the product. Every rule below exists to protect financial integrity.

## USERS
| User | Interaction |
|---|---|
| ADMIN | Sets salaries, configures policy, generates and reviews payroll, adds deductions and bonuses, finalizes, marks paid, creates adjustments |
| EMPLOYEE | Views own current estimate and own finalized payslips only |
| MANAGER | No payroll access in V1 |

## DATA
**employee_salaries** — salary history with `effective_from` / `effective_to`. Changing a salary closes the current row and inserts a new one. Amounts are never updated in place.
**salary_policies** — the configurable calculation engine.
**payroll_periods** — one per company per month, with state.
**payroll_lines** — one per employee per period, with a `snapshot` JSON and an `is_locked` flag.
**payroll_deductions / payroll_bonuses** — append-only, each with amount, reason, created_by, created_at.
**payroll_adjustments** — the only legal path to changing a finalized outcome.

All monetary values are `DECIMAL(15,2)`. **Never float.**

## SCREENS
`/admin/payroll` · `/admin/payroll/:periodId` · `/admin/payroll/:periodId/:employeeId` · `/admin/settings/salary-policy` · employee profile Salary tab · `/app/salary` · `/app/salary/history` · `/app/salary/:periodId`

## SALARY CALCULATION ENGINE

### Critical rule
**Do not hardcode one universal salary calculation.** Companies in this market compute daily wage in at least three different ways, and they are all correct for their own contracts. The engine is configuration.

### Daily wage basis (configurable)
| Option | Formula | Typical use |
|---|---|---|
| `fixed_days` | `monthly_salary ÷ fixed_days_value` (e.g. 30 or 26) | Most common in Egyptian SMEs |
| `scheduled_working_days` | `monthly_salary ÷ working days in that month per schedule` | Contract-driven |
| `calendar_days` | `monthly_salary ÷ days in month` | Some daily-rate arrangements |

**Example (illustrative only):**
```
Monthly salary: 20,000 EGP
Working days:   26
Daily wage:     20,000 ÷ 26 = 769.23 EGP
```
This is one configuration among several. It is not the system's fixed behaviour.

### Deduction rules (configurable)
| Setting | Options |
|---|---|
| `unpaid_leave_deduction` | daily_wage · scheduled_day_wage · none |
| `absence_deduction` | daily_wage · none |
| `lateness_rule` | none · per-minute rate · tiered (e.g. after N incidents) · fixed amount per incident |
| `overtime_rate` | multiplier applied to hourly rate, or none |
| `rounding` | none · nearest · up · down (to the nearest piastre or pound) |

### Calculation sequence
```
1. base_salary          = employee_salaries row effective for the period
2. working_days         = from work_schedule minus holidays, bounded by joining/termination dates
3. attendance counts    = present, wfh, absent, paid_leave, unpaid_leave, late_minutes
4. daily_wage           = per salary_policy.daily_wage_basis
5. attendance_adjustment = − (absent_days       × absence_deduction_rate)
                           − (unpaid_leave_days × unpaid_leave_rate)
                           − lateness_penalty per lateness_rule
                           + overtime_pay        per overtime_rate
6. total_deductions     = sum of manual deductions
7. total_bonuses        = sum of manual bonuses
8. net_salary           = base + attendance_adjustment − total_deductions + total_bonuses
9. apply rounding
```

**Worked example:**
```
Base salary          20,000
Late attendance        −200
Unpaid leave           −500
Other deduction        −300
Bonus                  +500
────────────────────────────
Final                19,500
```

## PAYROLL STATES

```
draft ──► under_review ──► approved ──► finalized ──► paid
  ▲            │                            │           │
  └────────────┘                            └───► adjusted ◄──┘
```

| State | Editable | Actions available |
|---|---|---|
| `draft` | ✅ | Recalculate · Add deduction/bonus · Submit for review · Discard |
| `under_review` | ✅ | Approve · Return to draft · Add deduction/bonus |
| `approved` | ❌ | Finalize · Return to review |
| `finalized` | **NEVER** | Mark paid · Create adjustment |
| `paid` | **NEVER** | Create adjustment |
| `adjusted` | **NEVER** | Create further adjustment |

## BUSINESS RULES

1. **Finalized payroll is immutable.** No admin, no endpoint, no support script modifies a finalized `payroll_line`. Enforced at the application layer and, where the database supports it, by a trigger.
2. **Corrections after finalization create an adjustment record** referencing the original line, with a required reason and its own audit trail. The original line is never touched.
3. **Generation is all-or-nothing.** Pre-flight validation runs first; if any employee lacks salary, schedule, or attendance data, generation halts, lists the blocking employees, and creates nothing.
4. **One period per company per month.** Unique `(company_id, year, month)`.
5. **Regeneration** is permitted only in `draft`, discards existing draft lines, and is audited.
6. **Every deduction and bonus requires a reason.** A deduction with no reason is not a deduction, it is an unexplained pay cut.
7. **Net salary cannot go below zero.** A deduction that would do so is blocked with an explanation. Whether negative net should ever be allowed is OD-06.
8. **Salary changes are historical.** The period uses the salary effective during that period, not today's salary.
9. **Employees see only their own data.** Enforced server-side.
10. **The employee's current-month figure is an estimate** and must be labelled as provisional until the period is finalized.
11. **Finalization requires typed confirmation** naming the period.
12. **Attendance changes are blocked** once the covering period is finalized.
13. **All monetary arithmetic uses fixed-precision decimals** and runs inside transactions.
14. **Rounding is applied once, at the end**, per policy — never at intermediate steps.

## EMPLOYEE SALARY VIEW

```
Current month
Monthly salary:            20,000 EGP
Estimated current salary:  18,750 EGP   ← labelled "تقديري"
Daily wage:                   769 EGP
Working days:                     26
Days worked:                      24
Leave balance:                8 days
```

Plus a history list of finalized payslips.

## PERMISSIONS
`payroll.view` (company/self) · `payroll.generate` · `payroll.add_deduction` · `payroll.add_bonus` · `payroll.approve` · `payroll.finalize` · `payroll.mark_paid` · `payroll.adjust` · `employee.view_salary` · `employee.set_salary` · `settings.salary_policy`.

## API REQUIREMENTS
The `/payroll` set per DOCUMENT 08 §4.10. All create endpoints accept `Idempotency-Key`. Finalization requires a confirmation token in the body.

## DATABASE REQUIREMENTS
Unique `(company_id, year, month)` and `(payroll_period_id, employee_id)`. Money as `DECIMAL(15,2)`. `payroll_lines.snapshot` JSON holds all computed inputs. `is_locked` prevents updates. Foreign keys `RESTRICT` — payroll records are never cascade-deleted. Indexes on `(company_id, year, month)` and `(employee_id, payroll_period_id)`.

## VALIDATION
- Period must not already exist in a non-draft state → 409.
- Every active employee must have a salary record covering the period.
- Every active employee must have a work schedule.
- Attendance must be complete for the period (no `pending` records) → warn and list.
- Deduction and bonus amounts > 0, with a required reason of at least 3 characters.
- Finalization confirmation string must match the period identifier.
- Adjustment amount ≠ 0, reason required.

## ERROR STATES
| Situation | Handling |
|---|---|
| Missing salary for an employee | Generation halts, blocking list shown with links to fix each employee |
| Incomplete attendance | Warning with a list of employees and dates; the admin may proceed knowingly or fix first |
| Period already finalized | 409, "تم إنهاء هذه الفترة. استخدم التسوية." |
| Deduction would make net negative | 422 with the resulting figure shown |
| Concurrent finalization | Optimistic lock; the second request receives 409 |
| Employee views another's payslip | 404 |

## EDGE CASES
| Case | Handling |
|---|---|
| Employee joins mid-month | Working days counted from the joining date; base salary pro-rated per policy |
| Employee terminated mid-month | Working days counted to the termination date; final settlement is out of V1 scope (OD-08) |
| Salary changed mid-month | The period uses the effective row(s); if two rows overlap the period, each portion is calculated separately and summed |
| Leave approved after finalization | Blocked; the admin is directed to the adjustment flow |
| Employee with zero attendance | Line generated with zero present days and full absence adjustment, flagged for review — not silently paid in full |
| Negative net after adjustments | Blocked pending OD-06 |
| Currency change mid-year | Out of scope; single currency per company in V1 |
| Payroll generated twice concurrently | Unique constraint plus idempotency key makes the second attempt return the first result |
| Deleted employee with payroll history | Soft delete only; payroll lines are retained and remain reportable |

## MOBILE BEHAVIOUR
- Employee salary view is fully mobile-optimised: a summary card, an expandable breakdown, and a payslip list.
- The provisional label is prominent on mobile, where the figure is most likely to be misread as final.
- Admin payroll management is desktop-first. On tablet the run table scrolls horizontally with a frozen employee column. Finalization is intentionally **not** available on mobile — an irreversible financial action should not be one mis-tap away.

## FUTURE EXTENSIONS
Tax and social insurance calculation, end-of-service settlement, loans and advances with instalment schedules, commission structures, multiple pay cycles (weekly, biweekly), bank transfer file export, payslip PDF generation and email delivery, multi-currency, and cost-centre allocation. None in V1.
