# DOCUMENT 13 — TASK & CHECKLIST SPECIFICATION

## PURPOSE
Assign work, track its progress objectively through checklists, and feed completion data into performance and goals. Tasks exist in this ERP mainly because they produce measurable output; they are not the product's centre.

## USERS
| User | Interaction |
|---|---|
| ADMIN | Creates, edits, assigns, cancels any task in the company |
| MANAGER | Same, scoped to their team |
| EMPLOYEE | Views assigned tasks, updates checklist, adds progress notes, changes status |

## DATA
**tasks:** title, description, assignee_employee_id, department_id, goal_id, priority, status, start_date, deadline, completed_at, progress_percent, created_by, cancelled_reason.
**task_checklist_items:** task_id, title, is_completed, completed_at, completed_by, position.
**task_progress_updates:** task_id, employee_id, note, progress_percent_at_time, created_at — append-only.

**Statuses:** not_started · in_progress · completed · cancelled · on_hold.
**Priorities:** low · medium · high · urgent.

## SCREENS
Admin: `/admin/tasks` (table and board views) · `/admin/tasks/new` · `/admin/tasks/:id`
Employee: `/app/tasks` · `/app/tasks/:id`

## ACTIONS
| Actor | Action |
|---|---|
| Admin/Manager | Create · Edit · Reassign · Change deadline · Change priority · Add/remove/reorder checklist items · Cancel · Delete (soft) · View progress history |
| Employee | Tick/untick checklist items · Add progress note · Upload attachment · Change status within allowed transitions · View history |

## BUSINESS RULES

1. **Overdue is derived, never stored.** `deadline < today AND status ∉ {completed, cancelled}`. There is no "Overdue" value in the status enum and no way to set it manually.
2. **Progress formula:**
   ```
   progress = (completed checklist items ÷ total checklist items) × 100
   ```
   Example: 6 of 8 → 75%.
3. **Tasks without a checklist** use manually set progress in 25% steps, or simply derive 0% / 100% from status. The company chooses via settings (OD-10).
4. **Status transitions** are validated server-side:
   ```
   not_started → in_progress, cancelled, on_hold
   in_progress → completed, on_hold, cancelled
   on_hold     → in_progress, cancelled
   completed   → in_progress   (reopen; audited, requires reason)
   cancelled   → (terminal)
   ```
5. **First checklist tick or first progress note** moves `not_started` → `in_progress` automatically.
6. **Completing with open checklist items** is allowed but requires confirmation naming the count.
7. **Cancellation requires a reason.**
8. **Completing a task linked to a Task-type goal** recalculates that goal's current value in the same transaction.
9. **Progress updates are append-only.** History is never edited or deleted.
10. **Reassignment** notifies both the previous and new assignee and is audited.
11. **Deadline changes on an overdue task** are audited with old and new values.
12. Employees cannot create, delete, reassign, or re-deadline tasks.

## PERMISSIONS
`task.view` (company/team/self) · `task.create` · `task.update` · `task.delete` · `task.update_status` (employee limited to assigned tasks) · `task.update_checklist` · `task.add_progress_note`.

## API REQUIREMENTS
The `/tasks` set in DOCUMENT 08 §4.7, including checklist sub-resources and `/tasks/summary` for dashboard counts.

## DATABASE REQUIREMENTS
Indexes on `(company_id, status)`, `(assignee_employee_id, status)`, `(company_id, deadline)`, `(task_id, position)` for checklist ordering. Soft delete on tasks. Cascade delete on checklist items and progress updates. `goal_id` is `SET NULL` on goal deletion.

## VALIDATION
- Title required, 3–255 characters.
- Assignee must be an active employee within the caller's scope.
- `deadline ≥ start_date` when both are supplied.
- Linked goal must belong to the same company and, when employee-scoped, the same employee.
- Checklist item title required, maximum 255 characters.
- Progress note maximum 2000 characters, and must not be empty or whitespace.
- Status transition validated against the matrix above; an invalid transition is 422, not a silent no-op.

## ERROR STATES
| Situation | Handling |
|---|---|
| Invalid status transition | 422 explaining the allowed transitions |
| Assignee deactivated | Blocked with "الموظف غير نشط" and a suggestion to reassign |
| Checklist tick fails | Optimistic UI rolls back, an error toast appears, and the item returns to its previous state |
| Task not found or out of scope | 404 |
| Completing a cancelled task | 422 — cancelled is terminal |

## EDGE CASES
| Case | Handling |
|---|---|
| All checklist items deleted | Progress falls back to the no-checklist rule; does not divide by zero |
| Checklist added after task completion | Progress recalculates; the task stays completed unless explicitly reopened |
| Assignee deactivated with open tasks | Tasks remain and surface in a "tasks needing reassignment" list on the admin dashboard |
| Deadline in the past at creation | Allowed (back-dated work) but warned |
| Task linked to a goal outside its period | Warned at creation; the task does not contribute to that goal's progress |
| Reopening a completed task that already counted toward a goal | Goal current value is recalculated downward, and the change is audited |
| Two users tick the same checklist item simultaneously | Last write wins; the item's completed state is idempotent so no error is shown |

## MOBILE BEHAVIOUR
- `/app/tasks` groups tasks: Due today · Overdue · In progress · Not started · Completed.
- Task cards are full-width with priority chip, deadline, and a progress ring.
- Checklist items are large tap targets with immediate optimistic feedback.
- The progress-note composer is a bottom sheet.
- The admin board view becomes one swipeable column at a time — it is never shrunk to fit.
- Attachment upload uses the native camera and file picker.

## FUTURE EXTENSIONS
Subtasks, task dependencies, recurring tasks, time tracking per task, task templates, comment threads with mentions, task labels or tags, effort estimation and burndown, and a team workload view. None in V1.
