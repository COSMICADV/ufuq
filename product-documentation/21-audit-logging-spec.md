# DOCUMENT 21 — AUDIT LOGGING SPECIFICATION

## PURPOSE
Make every material action in the system attributable, explicable, and reviewable. In an ERP handling salary and stock, "who changed this and when" is not a nice-to-have.

## DATA
**audit_logs:** company_id, user_id, action, entity_type, entity_id, old_values (JSON), new_values (JSON), ip_address, user_agent, created_at.

**Append-only.** No UPDATE. No DELETE. No soft delete. There is no API, no admin screen, and no support script that modifies an audit record.

## AUDITED ACTIONS

### Authentication & access
`login.success` · `login.failed` · `login.locked` · `logout` · `password.changed` · `password.reset_requested` · `password.reset_completed` · `invitation.sent` · `invitation.accepted` · `session.revoked` · `permission.denied` · `tenancy.violation_attempt`

### Employees
`employee.created` · `employee.updated` · `employee.deactivated` · `employee.activated` · `employee.manager_changed` · `employee.department_changed` · `employee.role_changed` · `employee.salary_changed`

### Attendance
`attendance.checked_in` · `attendance.checked_out` · `attendance.adjusted_by_admin` · `attendance.correction_requested` · `attendance.correction_approved` · `attendance.correction_rejected` · `attendance.generated_by_system`

### Leave
`leave.requested` · `leave.approved` · `leave.rejected` · `leave.cancelled` · `leave.balance_adjusted` · `leave_type.created` · `leave_type.updated`

### Requests
`request.submitted` · `request.approved` · `request.rejected` · `request.cancelled`

These record the lifecycle of the Requests Centre's own categories (Salary, Task, General) and the requester's cancellation of a request. Specialised records keep their own actions — an attendance correction is audited as `attendance.correction_requested` / `attendance.correction_approved` / `attendance.correction_rejected`, and leave as `leave.*`.

### Tasks & goals
`task.created` · `task.updated` · `task.reassigned` · `task.deadline_changed` · `task.status_changed` · `task.cancelled` · `task.deleted` · `task.reopened` · `checklist.item_added` · `checklist.item_deleted` · `goal.created` · `goal.updated` · `goal.progress_updated` · `goal.target_changed` · `goal.cancelled`

### Payroll — the most heavily audited area
`payroll.generated` · `payroll.regenerated` · `payroll.submitted_for_review` · `payroll.approved` · `payroll.returned_to_draft` · `payroll.finalized` · `payroll.marked_paid` · `payroll.adjustment_created` · `deduction.added` · `bonus.added` · `salary_policy.changed`

### Inventory
`product.created` · `product.updated` · `product.deactivated` · `stock.movement_created` · `stock.transfer_executed` · `stock.reconciliation_run` · `warehouse.created` · `warehouse.updated` · `warehouse.deactivated` · `supplier.created` · `supplier.updated`

### Settings & data access
`settings.company_updated` · `settings.schedule_changed` · `settings.performance_weights_changed` · `settings.notification_changed` · `report.exported` · `attachment.uploaded` · `attachment.deleted` · `attachment.accessed` (sensitive attachments only)

## RECORD CONTENT

| Field | Rule |
|---|---|
| `user_id` | The acting user. System actions record a designated system user, never null |
| `action` | From the enumerated list above. Free-text actions are not permitted |
| `entity_type` / `entity_id` | The affected record |
| `old_values` | Only the fields that changed |
| `new_values` | Only the fields that changed |
| `ip_address` | Captured where legally appropriate |
| `user_agent` | Captured where legally appropriate |
| `created_at` | Server time, UTC |

**Never captured:** password hashes, plaintext passwords, tokens, session identifiers, full attachment contents.

**Captured with care:** salary amounts are audited (this is exactly what audit exists for) but the audit viewer requires `audit.view`, and salary values are visible in it only to roles that also hold `employee.view_salary`.

## BUSINESS RULES

1. **Audit after commit.** A rolled-back transaction produces no audit record.
2. **Audit writes must not fail silently.** If the write fails, it is logged to a fallback and retried. A dropped audit record is a defect.
3. **Audit writes must not block the user's request** where volume is high — asynchronous with guaranteed delivery is acceptable; fire-and-forget is not.
4. **Only changed fields** are stored, keeping records small and readable.
5. **Records are queryable per entity**, powering a history panel on employee, task, payroll, and product screens.
6. **Retention: 7 years minimum** for financial and inventory actions.
7. **Audit records are company-scoped** like everything else. `audit.view` never crosses tenants.
8. **System-generated actions are audited too** — the absence-marking job, the monthly report job, and the carry-over job all leave records.

## PERMISSIONS
`audit.view` — ADMIN only in V1. Read-only. There is no write, update, or delete permission because there is no such capability.

## API REQUIREMENTS
`GET /audit-logs` with filters for user, entity type, entity id, action, and date range.
`GET /audit-logs/entity/{type}/{id}` for a record's history.

No POST, PATCH, or DELETE endpoints exist for this resource.

## DATABASE REQUIREMENTS
Indexes: `(company_id, created_at)` · `(entity_type, entity_id)` · `(user_id, created_at)` · `(company_id, action, created_at)`.
Table will grow large — plan partitioning by month or archival to cold storage after 12 months, with archived records still retrievable.
Database permissions should deny UPDATE and DELETE on this table to the application user, so the immutability rule is enforced by the database and not only by convention.

## UI

**Audit log screen** (`/admin/settings/audit-log`): filterable, paginated, read-only. Each row renders as a human-readable sentence — "أحمد محمد أضاف خصم ٢٠٠ ج.م لراتب سارة أحمد" — with an expandable technical detail view showing old and new values.

**Entity history panels** appear on employee, task, payroll line, and product detail screens, showing that record's audit trail inline.

## ERROR STATES
| Situation | Handling |
|---|---|
| Audit write fails | Logged to a fallback, retried, and alerted. The user's action still succeeds — but the failure is never invisible |
| Referenced entity deleted | The audit record remains and renders with the stored identifier and a "record no longer available" note |
| Very large `old_values` | Truncated with a marker; large blobs are never stored in audit |

## EDGE CASES
| Case | Handling |
|---|---|
| Bulk operation | One audit record per affected entity, plus one summary record for the operation |
| System job with no acting user | A designated system user id, never null |
| Retroactive data change | Audited with the change date **and** the effective date, since they differ |
| User deleted | Audit records retain `user_id`; the viewer shows the stored name from the record, not a broken join |
| Clock adjustment | Server time only; client timestamps are never trusted |

## FUTURE EXTENSIONS
Tamper-evidence via hash chaining, audit export for external compliance review, anomaly detection on audit patterns, a per-user activity timeline, and configurable retention per action category. None in V1.
