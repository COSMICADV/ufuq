# DOCUMENT 19 — NOTIFICATION SPECIFICATION

## PURPOSE
Tell the right person that something needs their attention, without becoming noise they learn to ignore.

## ARCHITECTURE

```
Domain event  →  Notification rule  →  Recipient resolution  →  Channel dispatch  →  Storage
```

Events are emitted by the service layer after a transaction commits. A notification is never sent for an action that was rolled back.

**Channels:** `in_app` (V1) · `email` (architecture ready, not implemented) · `push` (architecture ready, not implemented).

Do not implement email or push in V1. Build the channel abstraction so adding them later is a new dispatcher class, not a rewrite.

## DATA
**notifications:** company_id, user_id, type, title_ar, title_en, body_ar, body_en, related_type, related_id, channel, read_at, created_at.

Both language variants are stored so the recipient's locale can change without breaking history.

## ADMIN / MANAGER NOTIFICATIONS

| Type | Trigger | Priority |
|---|---|---|
| `leave_request_submitted` | Employee submits leave | High |
| `attendance_correction_submitted` | Employee submits a correction | High |
| `request_submitted` | Any other request category | Medium |
| `task_overdue` | Task passes its deadline | Medium |
| `low_stock` | Product quantity crosses `min_stock` | High |
| `out_of_stock` | Product quantity reaches zero | High |
| `goal_milestone` | A team goal crosses 25/50/75/100% | Low |
| `payroll_ready` | Payroll generation completes | High |
| `employee_missing_checkout` | Nightly job finds an unclosed record | Low |
| `tasks_need_reassignment` | Employee deactivated with open tasks | Medium |

## EMPLOYEE NOTIFICATIONS

| Type | Trigger | Priority |
|---|---|---|
| `task_assigned` | Task assigned to them | High |
| `task_deadline_approaching` | 24 hours before deadline | Medium |
| `task_updated` | Their task is edited or reassigned | Low |
| `leave_approved` / `leave_rejected` | Decision made | High |
| `correction_approved` / `correction_rejected` | Decision made | High |
| `request_reviewed` | Any other request decided | Medium |
| `salary_finalized` | Payroll finalized | High |
| `goal_assigned` | New goal | Medium |
| `goal_milestone` | Own goal crosses a milestone | Low |
| `monthly_report_ready` | Monthly report generated | Low |
| `missing_checkout` | They forgot to check out | Medium |

## BUSINESS RULES

1. **Recipient resolution follows permissions.** A manager is notified about their team; an admin about the company. Never notify someone about a record they cannot open.
2. **Notifications are created after commit.** No notification for a rolled-back transaction.
3. **Deduplication:** low-stock notifications fire once per threshold crossing, not on every subsequent movement. The same applies to overdue tasks — once per task, not daily.
4. **Grouping:** more than 3 notifications of the same type for the same user within an hour are collapsed into one summary ("٥ طلبات إجازة جديدة").
5. **Every notification links to its source record.** A notification with nowhere to go should not exist.
6. **Reading marks it read**; a mark-all-read action is available.
7. **Notification content contains no sensitive figures.** "تم اعتماد راتبك" — not the amount. The amount is behind the authorization check on the destination screen.
8. **Retention:** 12 months, then purged.
9. **Failed dispatch is retried** with backoff and logged. Silent loss is a defect.
10. **Per-event channel preferences** live in company settings; per-user preferences are future work.

## PERMISSIONS
Users see only their own notifications. There is no endpoint that lists another user's notifications.

## API REQUIREMENTS
`GET /notifications` · `GET /notifications/unread-count` · `POST /notifications/{id}/read` · `POST /notifications/read-all`.

Unread count is polled on navigation and on an interval (default 60s), not on every render.

## DATABASE REQUIREMENTS
Index `(user_id, read_at, created_at)` for the unread badge and the list. Partition or archive by date if volume grows. Hard delete permitted after the retention window.

## VALIDATION
Type must be a known enum value. Recipient must be an active user in the same company. `related_type` and `related_id` must resolve to an existing record.

## ERROR STATES
| Situation | Handling |
|---|---|
| Related record deleted | Notification renders with a "no longer available" state rather than a broken link |
| Dispatch failure | Retried with backoff; permanent failure is logged and alerted |
| Recipient deactivated | Notification is created but not dispatched to external channels |

## EDGE CASES
| Case | Handling |
|---|---|
| Employee is their own approver (small company admin) | Suppress self-notification for their own action |
| Multiple approvers | All eligible approvers are notified; the first decision resolves it and the notification is marked handled for the others |
| Bulk operation | One summary notification, not one per affected record |
| Notification created just as the user is deactivated | Stored, never dispatched |
| User changes language | Existing notifications render in the new language because both variants are stored |

## MOBILE BEHAVIOUR
Bell with unread dot in the header. The notification list is grouped by day with unread items emphasised. Tapping navigates to the source and marks read. Pull to refresh. Push notifications are future work; the in-app centre is the V1 surface.

## FUTURE EXTENSIONS
Email digests, web and mobile push, per-user channel preferences, quiet hours, in-notification actions (approve directly from the notification), WhatsApp or SMS for critical events, and escalation when a high-priority notification goes unread. None in V1.
