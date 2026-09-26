# DOCUMENT 14 — GOALS & PERFORMANCE SPECIFICATION

## PURPOSE
Set measurable targets for employees over a period, track progress against them, and combine goal achievement with attendance and task data into a performance picture that feeds monthly reports.

Goals differ from tasks. A task is a unit of work with a deadline. A goal is a **target value over a period** that many tasks, sales, or other outcomes contribute to.

## USERS
| User | Interaction |
|---|---|
| ADMIN | Creates goals for anyone, updates progress, configures performance weights |
| MANAGER | Creates goals for their team, updates progress |
| EMPLOYEE | Views own goals and progress — read-only |

## DATA
**goals:** employee_id, type, title, description, target_value, current_value, unit, period_start, period_end, status, task_count_rule (JSON), created_by.
**goal_progress:** goal_id, value, previous_value, note, source (manual/system), created_by, created_at — append-only.
**performance_config:** per-company weights.

**Types:** `sales` · `task` · `custom`. The enum is extensible; adding a type must not require touching progress calculation for existing types.
**Statuses:** active · achieved · missed · cancelled.

## SCREENS
Admin: `/admin/goals` · `/admin/goals/new` · `/admin/goals/:id`
Employee: `/app/goals/:id` (read-only), goal cards on `/app`
Settings: `/admin/settings/performance`
Reports: employee profile Goals tab, monthly report goal section

## ACTIONS
| Actor | Action |
|---|---|
| Admin/Manager | Create · Edit · Update progress · Cancel · View history |
| System | Recalculate task-type goal progress when a linked task completes |
| Employee | View own goals and progress history |

## BUSINESS RULES

1. **Progress formula:** `progress = (current_value ÷ target_value) × 100`.
2. **Display is capped at 100%**, but the true value is retained so over-achievement is visible in reports (e.g. "112% of target").
3. **Sales and Custom goals** take manual progress updates from Admin or Manager. Employees never edit their own goal figures.
4. **Task goals** derive `current_value` automatically from completed tasks matching `task_count_rule` within the goal period. No manual entry.
5. **Progress history is append-only.** `goal_progress` records the new value, previous value, and note. The current value on the goal is a cache of the latest history row.
6. **Milestones** at 25%, 50%, 75%, 100% trigger a notification to the goal owner and creator.
7. **Period end** transitions the goal automatically: `achieved` if progress ≥ 100%, otherwise `missed`.
8. **`period_end` must be after `period_start`.** Overlapping goals of the same type for the same employee are allowed but warned.
9. **Reopening or recalculating** a goal never deletes history — a new history row is appended.

### Worked examples

**Sales goal** — Target 100,000 EGP, Current 75,000 EGP → 75%.
**Task goal** — Target 20 tasks, Completed 15 → 75%.
**Custom goal** — Customer Satisfaction, Target 90%, Current 84% → 93.3% toward target.

Note the third case: the goal *unit* is itself a percentage, and progress toward the target is a different number from the current value. The UI must show both without confusing them: "84% (93.3% من الهدف)".

## PERFORMANCE

### Critical rule
**The performance formula is configuration, not code.** No weight, threshold, or coefficient is hardcoded anywhere. The company configures the model, and the model in effect at generation time is stored inside the monthly report snapshot so historical reports remain explicable.

### Component scores

**Attendance score** — from present days, WFH days, late incidents, absent days, against scheduled working days.
Default model:
```
attendance_score = ((present + wfh + paid_leave) ÷ working_days) × 100
                   − (late_incidents × late_penalty)
                   − (absent_days × absence_penalty)
clamped to 0–100
```

**Task score** — from completion and deadline adherence.
Default model:
```
completion_rate     = completed ÷ assigned × 100
on_time_rate        = completed_on_time ÷ completed × 100
task_score = (completion_rate × completion_weight) + (on_time_rate × on_time_weight)
```

**Goal score** — average of the employee's active goal progress values for the period, each capped at 100 for scoring purposes.

**Overall performance**
```
overall = (attendance_score × w_attendance)
        + (task_score       × w_task)
        + (goal_score       × w_goal)
```

### Default weights (a starting point, fully configurable)
| Component | Weight |
|---|---|
| Attendance | 0.30 |
| Tasks | 0.40 |
| Goals | 0.30 |
| late_penalty | 1.0 point per incident |
| absence_penalty | 5.0 points per day |
| completion_weight | 0.6 |
| on_time_weight | 0.4 |

Weights must sum to 1.0; the settings screen enforces this.

### Worked example — Ahmed Mohamed, September
```
Attendance: present 22 · WFH 7 · late 2 · absent 0 · working days 26
Tasks:      completed 18 · in progress 4 · overdue 1 · assigned 23
Goals:      sales 82% · tasks 90%

attendance_score = ((22 + 7) ÷ 26 × 100) − (2 × 1.0) − 0 = 111.5 → clamped 100 → minus late = 98.0
task_score       = (18÷23×100 × 0.6) + (on-time rate × 0.4)
goal_score       = (82 + 90) ÷ 2 = 86.0
overall          = (98.0 × 0.30) + (task_score × 0.40) + (86.0 × 0.30)
```

This example uses the default weights. A company that weights attendance at 0.5 gets a different, equally valid number. **That is the point** — the formula must never be treated as a universal truth baked into code.

### Employees with no data
An employee with no assigned tasks has no task score. The component is **excluded and the remaining weights are renormalised** — it is not scored as zero. Scoring absent components as zero punishes employees for management's failure to assign work.

## PERMISSIONS
`goal.view` (company/team/self) · `goal.create` · `goal.update` · `goal.update_progress` · `settings.performance_weights` · `report.employee_monthly`.

## API REQUIREMENTS
`/goals` set per DOCUMENT 08 §4.8, plus `GET/PATCH /performance-config` and `GET /employees/{id}/performance`.

## DATABASE REQUIREMENTS
`goals` indexed on `(company_id, employee_id, status)` and `(company_id, period_end)`. `goal_progress` indexed on `(goal_id, created_at)`, append-only. `performance_config` stored per company as structured JSON with a schema version.

## VALIDATION
- `target_value` > 0.
- `period_end` > `period_start`.
- Type-specific: Task goals require a `task_count_rule`; Sales goals require a currency unit.
- Progress value must be numeric and non-negative.
- Performance weights must each be 0–1 and sum to exactly 1.0.
- Owner must be an active employee within the caller's scope.

## ERROR STATES
| Situation | Handling |
|---|---|
| Weights don't sum to 1.0 | Settings save blocked with the current sum shown |
| Progress update on a cancelled goal | 422 |
| Target value zero | 422 — would divide by zero |
| Performance requested for a month with no data | Report renders with components marked "لا توجد بيانات" rather than showing 0% |

## EDGE CASES
| Case | Handling |
|---|---|
| Target changed mid-period | Allowed, audited, and the progress history retains the old target so the chart does not lie |
| Employee transfers department mid-period | The goal stays with the employee, not the department |
| Goal period spans two payroll months | Monthly reports show the progress snapshot at each month end |
| Over-achievement (150%) | Display caps at 100%, true value shown as text and used in reports |
| Task goal with zero qualifying tasks | Progress 0%, and the goal is flagged in the admin view as possibly misconfigured |
| Employee terminated mid-period | Goal is closed at the termination date and scored against the elapsed portion |
| Weights changed after reports were generated | Historical reports keep the weights stored in their snapshot and are not retroactively rescored |

## MOBILE BEHAVIOUR
Goal cards are full-width with a progress bar, current and target values, and days remaining in the period. The detail view stacks the progress chart above the history list. Read-only for employees, so no editing affordances appear.

## FUTURE EXTENSIONS
Team and department-level goals, OKR-style key results nested under objectives, goal templates, cascading company → department → employee goals, peer and self review inputs, weighted goals within a period, and calibration across managers. None in V1.
