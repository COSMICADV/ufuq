# OPEN DECISIONS

Every requirement below needs a decision before or during development. Nothing here is a silent assumption — each is stated, with options, a recommendation, and the consequence of choosing wrongly.

**Blocking** decisions must be resolved before the phase named. **Non-blocking** decisions have a documented default that can proceed.

---

## OD-01 — Can one user belong to multiple companies?
**Status:** Blocking — Phase 3
**Unclear:** V1 assumes one user, one company. A consultant or an owner of two companies breaks that.
**Why it matters:** It determines whether email is unique globally or per company, and whether a `company_users` membership table is needed. Retrofitting this after launch is a painful migration touching authentication, sessions, and every scoped query.
**Options:** A) One company per user (simple, matches V1 assumption). B) Membership table from day one with a company switcher.
**Recommended:** A, with the schema shaped so B is an additive change rather than a restructure.
**Consequence of A:** a user needing two companies must hold two accounts until B ships.

## OD-02 — Session cookies or bearer tokens?
**Status:** Blocking — Phase 3
**Unclear:** The web client can use either. Future mobile apps need tokens.
**Why it matters:** It determines CSRF strategy, storage, and refresh handling.
**Options:** A) Cookie sessions for web, add tokens later for mobile. B) Tokens from the start for both.
**Recommended:** A. Cookie sessions are more secure by default for a browser client, and the token path can be added alongside without changing the web client.

## OD-03 — Are managers able to approve their own requests?
**Status:** Blocking — Phase 9
**Unclear:** In a small company the manager may be the only approver above an employee, and may also be an employee themselves.
**Why it matters:** Self-approval defeats the purpose of the workflow, but blocking it entirely may leave a two-person company unable to process leave at all.
**Options:** A) Self-approval always blocked; an ADMIN must approve manager requests. B) Configurable per company. C) Allowed but prominently flagged in the audit log.
**Recommended:** A, with ADMIN as the fallback approver.
**Decision (approved, Phase 9):** A. Self-review is never allowed, for a MANAGER or an ADMIN, and it is blocked server-side. A manager's request is reviewed by an ADMIN; an ADMIN's own request by another ADMIN.
**V1 fallback (approved):** if the requester is the only eligible ADMIN, the request may still be submitted; it stays Pending; the requester may cancel it while it is Pending; and it can be reviewed only once another eligible ADMIN exists. V1 has no secondary-approver setting, and no temporary review power is granted to a MANAGER.

## OD-04 — Default work mode on check-in?
**Status:** Non-blocking — Phase 6. Default: no default.
**Unclear:** Whether check-in should pre-select OFFICE.
**Why it matters:** A pre-selected mode gets mis-tapped and produces wrong data that flows into reports and possibly allowances.
**Options:** A) No default; the employee must choose. B) Default to OFFICE. C) Default to the employee's most common mode.
**Recommended:** A. One extra tap is worth accurate data.

## OD-05 — Overnight shifts in V1?
**Status:** Blocking — Phase 6
**Unclear:** Whether a shift crossing midnight must be supported in V1.
**Why it matters:** It affects the attendance record's date semantics, the working-hours calculation, and the nightly jobs. Adding it later means reworking the calculation engine.
**Options:** A) Not in V1; schedules must be within one day. B) Supported via an `is_overnight` flag on the schedule, with the record belonging to the check-in date.
**Recommended:** B for the **schema** even if the UI is deferred — so the data model does not need migrating later.

## OD-06 — Can net salary be negative?
**Status:** Blocking — Phase 11
**Unclear:** Whether deductions may exceed the base salary in a period.
**Why it matters:** It is legally sensitive in most jurisdictions and it determines whether the system blocks or carries the excess forward.
**Options:** A) Never negative; deductions cap at the net. B) Blocked with an error, forcing the admin to split the deduction across periods. C) Allowed, carried forward as a debt.
**Recommended:** B for V1. A silently caps and loses the remainder; C requires a debt-tracking mechanism that is out of scope.
**Decision (approved, Phase 11):** B. Net salary can never be negative. A deduction, an attendance calculation or an adjustment that would take a net below zero is refused with an error that shows the attempted figure, and nothing is applied. It is never capped and never carried forward as a debt; the Admin splits a large deduction across periods by hand.

## OD-07 — Should managers see their team's salaries?
**Status:** Blocking — Phase 11
**Unclear:** V1 defaults to no.
**Why it matters:** Some companies expect managers to handle their team's compensation; others treat it as strictly confidential.
**Options:** A) Never (V1 default). B) Configurable per company. C) Always.
**Recommended:** A for V1, with the permission model already able to express B when a company asks for it.
**Decision (approved, Phase 11):** A. MANAGER has no salary and no payroll access in V1, including for their own team: `employee.view_salary` is ADMIN = company, MANAGER = none, EMPLOYEE = self. It is enforced server-side.

## OD-08 — End-of-service settlement in V1?
**Status:** Blocking — Phase 11
**Unclear:** What happens financially when an employee is terminated — unused leave encashment, notice period, gratuity.
**Why it matters:** It is legally mandated in most of the region and companies will expect it.
**Options:** A) Out of V1; terminated employees receive a normal pro-rated final payroll and the rest is handled manually. B) Full settlement module in V1.
**Recommended:** A. B is a significant module with jurisdiction-specific rules and belongs in V2 with proper legal input.
**Decision (approved, Phase 11):** A. End-of-service settlement (gratuity, notice, leave encashment) is out of V1 and has no module. A terminated employee receives only the normal pro-rated payroll; any settlement is handled manually outside the system.

## OD-09 — Requests table design
**Status:** Non-blocking — Phase 9. Default: hybrid.
**Unclear:** Whether attendance corrections and leave requests should live in the unified `requests` table or keep specialised tables with `requests` as an index.
**Why it matters:** It affects query complexity and how much validation logic is shared.
**Options:** A) Hybrid — specialised tables plus a unified inbox row (documented default). B) One wide table with nullable category-specific columns.
**Recommended:** A. B becomes a nullability swamp as categories grow.

## OD-10 — Progress for tasks without a checklist
**Status:** Non-blocking — Phase 7. Default: status-derived.
**Unclear:** How progress is expressed when a task has no checklist items.
**Options:** A) Derived from status only (0% / 50% / 100%). B) Manual entry in 25% steps. C) Configurable per company.
**Recommended:** A for V1. B invites inflated self-reported progress with no evidence behind it.

## OD-11 — Half-day and hourly leave
**Status:** Non-blocking — Phase 10. Default: not in V1.
**Unclear:** Whether leave must be requestable in half days.
**Why it matters:** It affects the balance data type (already `DECIMAL(5,2)`, so the schema supports it), the duration calculation, and the attendance record shape.
**Options:** A) Full days only in V1. B) Half days supported.
**Recommended:** A, with the decimal balance already in place so B is additive.
**Decision (approved, Phase 10):** A. Full days only in V1; the DECIMAL(5,2) balance and day count keep half days additive.

## OD-12 — Primary key type
**Status:** Blocking — Phase 1
**Unclear:** UUID v7 or BIGINT identity.
**Why it matters:** It affects index size, insert performance at scale, and whether record ids are guessable in URLs.
**Options:** A) UUID v7 — non-guessable, time-ordered, larger index. B) BIGINT — smaller and faster, but sequential ids leak record counts and invite enumeration.
**Recommended:** A. The tenancy checks make enumeration harmless in principle, but non-guessable ids are a useful second layer, and v7's time ordering avoids classic UUID index fragmentation.

## OD-13 — Inventory valuation method
**Status:** Blocking — Phase 14
**Unclear:** V1 assumes weighted average cost.
**Why it matters:** FIFO and LIFO require lot-level tracking, which is a materially larger data model. Changing later means re-architecting the movement table.
**Options:** A) Weighted average (V1 assumption). B) FIFO with lot tracking. C) Configurable.
**Recommended:** A for V1. It is the common practice for SMEs in this market, and lot tracking is already on the future list where FIFO belongs.
**Decision (approved, Phase 14):** A — weighted average cost. `average_cost` per (product, location) recalculates on every inbound movement as ((old_qty × old_avg) + (in_qty × in_cost)) ÷ (old_qty + in_qty), exact, rounded once to 0.01 half away from zero. Historical movements keep their own `unit_cost`; a transfer moves stock at the source location's average. FIFO, LIFO and lot-level valuation remain out of V1.

## OD-14 — Data retention periods
**Status:** Blocking — before launch
**Unclear:** The legally required retention for payroll and audit records in the target jurisdiction.
**Why it matters:** Too short is a compliance failure; too long is unnecessary liability and storage.
**Recommended:** Confirm with a local accountant or legal advisor before launch. The 7-year default in DOCUMENT 06 §9 is a placeholder based on common practice, not legal advice.

## OD-15 — Pricing model
**Status:** Resolved for Phase 16 — contact for pricing.
**Decision (approved Phase 16 handoff):** No invented prices, plans or limits. Present contact-for-pricing based on employee count and needs; commercial pricing remains to be approved.
**Unclear:** Per-employee, flat tiers, or module-based; and whether a free tier exists.
**Why it matters:** The pricing page cannot be written without it, and it may affect whether employee-count limits need enforcing in the application.
**Recommended:** Decide before Phase 16. If undecided, the pricing page ships with a contact form rather than invented numbers.

## OD-16 — Pro-rating for mid-year joiners
**Status:** Non-blocking — Phase 10. Default: pro-rated by month.
**Unclear:** How annual leave allowance is calculated for an employee joining in, say, September.
**Options:** A) Pro-rated by month worked. B) Full allowance regardless. C) Configurable.
**Recommended:** A as the default, C as the eventual answer.
**Decision (approved, Phase 10):** A. The joining month counts in full (joining any day of March gives 10 months), and `default_days_per_year × months ÷ 12` is rounded half away from zero to 2 decimal places (14 × 10 ÷ 12 = 11.67). No configurable pro-rating policy in V1.

## OD-17 — Company registration: self-service or invitation only?
**Status:** Decided — A (Phase 16).
**Decision (approved Phase 16 handoff):** Self-service; company and first ADMIN are created transactionally. Reuse the existing invitation email verification and session flows; no access until activation.
**Unclear:** Whether anyone can register a company from the public site, or whether registration is gated.
**Why it matters:** Self-service invites spam and abandoned tenants; gating slows growth.
**Options:** A) Self-service with email verification. B) Request access, manually approved. C) Self-service with a trial period and automatic suspension.
**Recommended:** B for the first cohort of real customers, moving to C once the onboarding path is proven.

## OD-18 — Who is notified when there are multiple eligible approvers?
**Status:** Decided — A (Phase 15): all eligible approvers are notified; the first decision marks the notification handled for the others.
**Unclear:** Whether every admin gets every request notification, which becomes noise in a company with four admins.
**Options:** A) All eligible approvers. B) The employee's direct manager first, escalating to admins after a delay. C) A designated approver per category.
**Recommended:** A for V1, with B as the natural evolution once real usage shows the noise level.

---

## SUMMARY

| ID | Decision | Blocking | Phase |
|---|---|---|---|
| OD-01 | Multi-company users | ✅ | 3 |
| OD-02 | Session vs token auth | ✅ | 3 |
| OD-03 | Manager self-approval (decided: A, Phase 9) | ✅ | 9 |
| OD-04 | Default work mode | — | 6 |
| OD-05 | Overnight shifts | ✅ | 6 |
| OD-06 | Negative net salary (decided: B, Phase 11) | ✅ | 11 |
| OD-07 | Manager salary visibility (decided: A, Phase 11) | ✅ | 11 |
| OD-08 | End-of-service settlement (decided: A, Phase 11) | ✅ | 11 |
| OD-09 | Requests table design | — | 9 |
| OD-10 | Checklist-free task progress | — | 7 |
| OD-11 | Half-day leave (decided: A, Phase 10) | — | 10 |
| OD-12 | Primary key type | ✅ | 1 |
| OD-13 | Valuation method (decided: A, Phase 14) | ✅ | 14 |
| OD-14 | Retention periods | ✅ | pre-launch |
| OD-15 | Pricing model | ✅ | 16 |
| OD-16 | Mid-year leave pro-rating (decided: A, Phase 10) | — | 10 |
| OD-17 | Registration gating | ✅ | 16 |
| OD-18 | Multi-approver notification (decided: A, Phase 15) | — | 15 |

**Eleven blocking decisions.** OD-12 blocks Phase 1, so it is the first one needed.

---

## ASSUMPTIONS MADE AND STATED

These are recorded in DOCUMENT 01 §6 and repeated here so they are not mistaken for settled facts:

| ID | Assumption | Risk if wrong |
|---|---|---|
| A-01 | One user account per company | Requires a membership table and a company switcher |
| A-02 | Single currency per company | Requires FX rates throughout payroll and inventory |
| A-03 | Self-reported attendance, no biometric or geofence | Changes the trust model and adds location privacy handling |
| A-04 | Monthly payroll only | The period model must become configurable |
| A-05 | Weighted average valuation | FIFO/LIFO require lot-level tracking |

**No assumption has been hidden.** Where the specification was silent, this package either states the assumption above or raises it as an open decision — it does not quietly choose and move on.

---

# AWAITING APPROVAL

Development has not started and will not start until this documentation is approved.

**Next steps, in order:**
1. Review all 27 documents.
2. Resolve the eleven blocking decisions above — OD-12 first, since it blocks Phase 1.
3. Confirm or amend the MVP boundary in DOCUMENT 24.
4. Approve the package.
5. Begin Phase 1 per DOCUMENT 25, with DOCUMENT 27 loaded at the start of every session.
