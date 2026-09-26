# DOCUMENT 05 — USER FLOWS

Notation: `→` step · `◆` decision · `⚠` failure path · `📝` audit record written · `🔔` notification sent.

---

## FLOW 01 — Login

```
Login screen
→ enter email + password
→ submit
◆ credentials valid?
  ├─ no  ⚠ generic error, increment attempt counter
  │       ◆ attempts ≥ 5 within 15 min? → temporary lockout message
  ├─ yes ◆ account active?
  │       ├─ no ⚠ "account deactivated, contact your administrator"
  │       └─ yes ◆ company active?
  │               ├─ no ⚠ "company subscription inactive"
  │               └─ yes → create session 📝
  │                       ◆ role
  │                         ├─ ADMIN/MANAGER → /admin
  │                         └─ EMPLOYEE      → /app
```

Never disclose which of email or password was wrong.

---

## FLOW 02 — Employee creation

```
Admin → /admin/employees → "موظف جديد"
→ Personal section    (name, email, phone, photo)
→ Employment section  (employee ID, department, position, manager, joining date)
→ Compensation        (monthly salary, policy override)
→ Schedule            (template or custom)
→ Leave allowances    (per leave type)
→ Access              (role, send invitation toggle)
→ Save
◆ validation
  ├─ fail ⚠ field errors, ALL input preserved
  └─ pass → transaction:
            create user (no password) 
            create employee
            create leave balances for the year
            create salary record
          → commit 📝
          ◆ send invitation?
            └─ yes → email invitation token 🔔
→ redirect to employee profile with success toast
```

---

## FLOW 03 — Employee onboarding

```
Employee receives invitation email
→ opens link
◆ token valid and unexpired?
  ├─ no ⚠ "expired — ask your administrator to resend"
  └─ yes → set password screen
          → password + confirm (strength enforced)
          → accept terms
          → submit
          → activate user, invalidate token, create session 📝
          → /app with a first-run tour of the attendance action
```

---

## FLOW 04 — Attendance check-in (OFFICE)

```
Employee → /app
→ attendance card shows [ مكتب ] [ عن بُعد ]
→ taps مكتب
◆ already checked in today?
  ├─ yes ⚠ "you already checked in at 08:57"
  └─ no ◆ is today a working day per schedule?
        ├─ no  → confirm dialog: "today is a rest day — record anyway?"
        └─ yes → create attendance record
                 date, employee, mode=OFFICE, check_in=now
                 → evaluate lateness against schedule + grace period
                 → status = Present or Late
                 → commit 📝
→ card switches to checked-in state with running timer
```

WFH is identical with `mode=WFH`.

---

## FLOW 05 — Check-out

```
Employee → taps "تسجيل انصراف"
◆ open record for today?
  ├─ no ⚠ "no check-in recorded today" + offer correction request
  └─ yes → set check_out = now
          → working_hours = check_out − check_in − unpaid breaks
          → overtime = max(0, working_hours − scheduled_hours) per policy
          ◆ working_hours < half-day threshold?
            └─ yes → status = Half Day
          → commit 📝
→ card shows final summary: in, out, total
```

---

## FLOW 06 — Attendance correction

```
Employee → /app/attendance/history → selects a day → "طلب تصحيح"
→ form pre-filled with current recorded values
→ enters requested check-in/out, mode, reason (required), optional attachment
◆ date within correction window (default 7 days)?
  ├─ no ⚠ "outside the correction window — contact your administrator"
  └─ yes → create request (status Pending) 📝 🔔 admin

Admin → /admin/requests or /admin/attendance/corrections
→ opens request: current vs requested, side by side
◆ decision
  ├─ Approve → transaction: update attendance record, set request Approved,
  │            record reviewer + timestamp → commit 📝 🔔 employee
  ├─ Reject  → reason required → status Rejected 📝 🔔 employee
  └─ More info → status stays Pending, response recorded 🔔 employee
```

⚠ If the affected month's payroll is already Finalized, approval is blocked with an explanation directing the admin to the payroll adjustment flow instead.

---

## FLOW 07 — Leave request

```
Employee → /app/requests/new → category = إجازة
→ selects leave type
→ system displays balance: total / used / remaining
→ picks start and end dates
→ system calculates duration excluding weekends and holidays per schedule
◆ requested days ≤ remaining balance?
  ├─ no ◆ leave type allows unpaid overflow?
  │      ├─ no  ⚠ "insufficient balance"
  │      └─ yes → warn that excess days are unpaid
  └─ yes → reason + optional attachment
◆ attachment required for this type (e.g. sick leave)?
  └─ yes and missing ⚠ blocked
→ submit → status Pending
→ reserve pending days against balance (soft hold) 📝 🔔 approver
```

## FLOW 08 — Leave approval

```
Admin/Manager → /admin/requests → filter إجازة
→ open request: employee context, balance, team calendar overlap
◆ decision
  ├─ Approve → transaction:
  │             deduct days from balance
  │             release soft hold
  │             create attendance records status = On Leave for each day
  │             set request Approved, reviewer, timestamp
  │            → commit 📝 🔔 employee
  └─ Reject  → reason required, release soft hold, status Rejected 📝 🔔 employee
```

⚠ Approval that would overlap an existing approved leave or an existing attendance record is blocked with the conflicting dates listed.

---

## FLOW 09 — Task creation

```
Admin/Manager → /admin/tasks → "مهمة جديدة"
→ name, description
→ assignee ◆ assignee active and within caller's scope?
→ department auto-filled from assignee (overridable)
→ priority, start date, deadline ◆ deadline ≥ start date
→ optional goal link ◆ goal belongs to same company (and employee, if scoped)
→ checklist items (0..n)
→ attachments
→ save → status = Not Started, progress = 0% 📝 🔔 assignee
```

## FLOW 10 — Task completion

```
Employee → /app/tasks/:id
→ ticks checklist items one by one
   each tick → recalculate progress = completed / total × 100
   optimistic UI, rollback on failure 📝
→ adds progress note: "أنهيت التصاميم الأولية وأرسلتها للمدير"
→ status transitions Not Started → In Progress on first activity
◆ employee sets status = Completed
  ◆ unchecked checklist items remain?
    └─ yes → confirm dialog: "3 items are still open. Complete anyway?"
  → status = Completed, completed_at = now 📝 🔔 creator
  ◆ task is linked to a Task-type goal?
    └─ yes → recalculate goal current value and progress 📝
```

⚠ Overdue is a derived state: `deadline < today AND status ∉ {Completed, Cancelled}`. It is computed, never stored as a manually settable status.

## FLOW 11 — Checklist

```
Add item  → Admin/Manager only, appended, progress denominator increases
Tick item → assignee or manager, progress recalculated 📝
Untick    → allowed, progress recalculated 📝
Delete    → Admin/Manager only, denominator decreases, progress recalculated 📝
Reorder   → position field updated, no progress effect
```

---

## FLOW 12 — Goal creation

```
Admin/Manager → /admin/goals → "هدف جديد"
→ type ◆ Sales | Task | Custom
→ owner (employee)
→ target value + unit  (EGP / tasks / % / custom)
→ period start and end ◆ end > start
→ for Task type: counting rule (which tasks contribute)
→ save, current value = 0 or derived 📝 🔔 owner
```

## FLOW 13 — Goal progress

```
Sales / Custom goal:
  Admin/Manager → goal detail → "تحديث التقدم"
  → new current value + optional note
  → append goal_progress row (never overwrite history)
  → recalculate progress = current / target × 100 (capped for display at 100%,
    actual value retained for over-achievement reporting) 📝
  ◆ crosses a milestone (25/50/75/100%)? → 🔔

Task goal:
  triggered automatically when a linked task is completed
  → current = count of qualifying completed tasks
  → progress recalculated 📝
```

---

## FLOW 14 — Payroll generation

```
Admin → /admin/payroll → select period (month) → "إنشاء كشف الرواتب"
◆ period already exists?
  ├─ Finalized/Paid ⚠ blocked — use adjustment flow
  └─ Draft → offer regenerate (discards draft lines, audited)
→ pre-flight validation:
   every active employee has salary, schedule, and complete attendance
   ⚠ any failures → halt, list blocking employees, generate nothing
→ transaction, per employee:
   working days from schedule
   present / WFH / absent / paid leave / unpaid leave from attendance
   daily wage per company salary policy
   attendance adjustment (absence + unpaid leave + lateness rule)
   base − adjustments + bonuses = net
   create payroll_line
→ commit, period state = Draft 📝
→ show run screen
```

## FLOW 15 — Deduction

```
Admin → payroll run (Draft or Under Review) → employee row → "إضافة خصم"
→ amount, reason (required), type
◆ amount > 0 and net would remain ≥ 0?
  ├─ no ⚠ blocked with explanation
  └─ yes → create deduction (created_by, created_at)
          → recalculate that line's net 📝 🔔 employee (optional, configurable)
```

Bonuses follow the identical flow with a positive sign.

## FLOW 16 — Payroll finalization

```
Draft → "إرسال للمراجعة" → Under Review
Under Review → review each line
  ├─ "إرجاع للمسودة" → Draft
  └─ "اعتماد" → Approved
Approved → "إنهاء" (finalize)
  → confirmation dialog requiring the admin to type the period name
  → transaction:
      snapshot every line's computed values immutably
      lock the period
      state = Finalized 📝 🔔 all employees
Finalized → "تسجيل الدفع" → Paid 📝
Finalized/Paid → "تسوية" (adjustment)
  → new adjustment record referencing the original line
  → reason required
  → original line NEVER modified
  → period state = Adjusted 📝 🔔 affected employee
```

---

## FLOW 17 — Inventory addition (new product)

```
Admin → /admin/inventory → "منتج جديد"
→ name, SKU ◆ SKU unique within company
→ category, unit, min stock, cost, selling price, supplier, image, description
→ initial stock: location + quantity (optional)
→ save → transaction:
   create product
   ◆ initial quantity > 0?
     └─ yes → create stock movement type = Manual Addition
              (never a direct quantity write) 📝
→ commit 📝
```

## FLOW 18 — Stock movement

```
Admin → product detail → "حركة مخزون"
→ type: Purchase | Sale | Transfer | Adjustment | Return | Damage | Manual +/-
→ location, quantity, unit cost (for inbound), reason (required for Adjustment/Damage)
◆ outbound and quantity > available at location?
  ├─ no negative stock policy → ⚠ blocked
  └─ negative allowed by policy → warn and continue
→ transaction:
   insert stock_movement (immutable)
   update product_stock balance for that location
   recalculate valuation
→ commit 📝
◆ resulting quantity ≤ min stock? → 🔔 low stock
◆ resulting quantity = 0?         → 🔔 out of stock

Transfer produces TWO paired movements (OUT at source, IN at destination)
inside ONE transaction. A half-completed transfer must be impossible.
```

---

## FLOW 19 — Monthly report

```
Trigger: scheduled job on the 1st of each month, or on-demand
→ for each active employee, for the closed month:
   attendance summary  (working days, present, WFH, late, absent, leave)
   task summary        (assigned, completed, in progress, overdue)
   goal summary        (per goal, progress at period end)
   salary summary      (base, deductions, bonuses, net — from payroll if finalized,
                        otherwise marked provisional)
   performance scores  (per configured weights, DOCUMENT 14)
→ persist as a monthly_report snapshot 📝
→ 🔔 employee "your monthly report is ready"
```

Reports are **snapshots**. Later edits to historical attendance do not silently rewrite a generated report; a regeneration is an explicit, audited action.

---

## FLOW 20 — Cross-cutting failure handling

Every flow above obeys these rules:

1. Any multi-record write runs in a transaction. Partial success is not an outcome.
2. On validation failure the user's input is preserved and field-level errors are shown.
3. On server error the user sees a retry action, not a dead end.
4. Any action that cannot proceed explains **why** and **what to do next** — never a bare "operation failed".
5. Destructive and irreversible actions (finalize payroll, deactivate employee, delete task) require explicit confirmation naming the object.
