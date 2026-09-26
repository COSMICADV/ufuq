# DOCUMENT 27 — CLAUDE DEVELOPMENT RULES

> **This document is the most important one in the package for the implementation phase.**
> Load it at the start of every coding session, alongside the specification for the module being worked on.

---

## THE 35 RULES

### Architecture

**RULE 1 — Never change the architecture without explaining why.**
If a specification's approach seems wrong, say so before writing code. Explain the problem, the alternatives, and the recommendation. Then wait.

**RULE 2 — Never invent a new feature unless explicitly requested.**
A field that "seemed useful", a filter that "would be handy", a status that "makes sense" — none of these are in the specification, so none of them get built.

**RULE 3 — Never remove an existing feature without approval.**
Including features that appear unused, redundant, or poorly implemented.

**RULE 4 — Read the relevant documentation before modifying a module.**
Working on payroll means reading DOCUMENT 15 first. Every time, not once at the start of the project.

**RULE 5 — Do not modify unrelated modules when implementing a feature.**
Implementing tasks means touching task code. Not "cleaning up" the attendance module along the way.

### Code structure

**RULE 6 — Do not duplicate business logic.**
If daily wage is calculated in two places, one of them will be wrong within three months.

**RULE 7 — Business rules should be centralized.**
Calculations live in a service or domain layer. Not in controllers, not in components, not in database views.

### Security

**RULE 8 — Never trust frontend permissions.**
A hidden button is a UX choice. It is not a security control.

**RULE 9 — All permissions must be validated server-side.**
Every protected endpoint, every time, without exception.

**RULE 10 — All company-owned data must be scoped to the correct company.**
Through the global query scope, not through a `where` clause a developer must remember to write.

**RULE 11 — Never expose another company's data.**
Not in responses, not in errors, not in logs, not in exports, not in aggregate report figures.

### Configuration over hardcoding

**RULE 12 — Do not hardcode company working hours.**
Saturday–Thursday 09:00–17:00 is a seed example, not a constant. If `WORKING_DAYS` appears in the code, it is a defect.

**RULE 13 — Do not hardcode salary calculation rules.**
`monthly_salary / 26` in code is a defect. It comes from `salary_policies`.

The same applies to performance weights, leave rules, grace periods, and half-day thresholds. All configuration.

### Financial integrity

**RULE 14 — Do not silently modify finalized payroll.**
No endpoint, no admin action, no support script. Corrections create adjustment records.

**RULE 15 — Do not silently modify historical inventory movements.**
Movements are immutable. Corrections are opposing adjustment movements with reasons.

**RULE 16 — Use transactions for operations that modify multiple related financial or inventory records.**
The full list is in DOCUMENT 06 §8. Partial success is not an acceptable outcome.

**RULE 17 — Use proper monetary data handling.**
`DECIMAL(15,2)`. Never float, never double. Rounding applied once, at the end, per policy.

**RULE 18 — Maintain auditability for important ERP actions.**
The list is in DOCUMENT 21. If an action is on that list and produces no audit record, the feature is incomplete.

### Components & design

**RULE 19 — Keep components reusable.**
Build against the design system from Phase 2. Do not build a one-off variant because it was faster in the moment.

**RULE 20 — Do not create unnecessary duplicated components.**
Check whether the component exists before writing a new one. `TableWithFilters` and `FilterableTable` should never coexist.

**RULE 21 — Follow the أُفق design system.**
DOCUMENT 10 is the authority on colour, type, spacing, radius, shadow, and component behaviour.

**RULE 22 — Do not introduce random colors.**
If a colour is not a token in DOCUMENT 10, it does not go in the code. No "just this one accent".

**RULE 23 — Do not introduce random typography.**
The scale in DOCUMENT 10 §2.2 is the whole scale.

### Localization

**RULE 24 — The application is RTL-first.**
Logical CSS properties everywhere. `margin-left` in layout code is a defect. Verify in Arabic before considering a screen done.

**RULE 25 — Do not break English support while implementing Arabic.**
Both directions work, always. No hardcoded strings in either language.

### Quality

**RULE 26 — Do not use placeholder UI in production modules.**
No lorem ipsum, no "Coming soon" panels, no fake data left behind, no TODO comments in shipped screens.

**RULE 27 — Every major screen must handle loading, empty, error and success states.**
All four. A screen missing one is not finished.

**RULE 28 — Every API endpoint must validate input.**
Server-side, whitelist-based, matching the documented rules.

**RULE 29 — Every protected API endpoint must verify authorization.**
Authentication, tenancy, permission, and scope. All four checks.

**RULE 30 — Before completing a task, test the affected functionality.**
Run it. Verify the happy path, at least one failure path, and the permission boundary. Do not report a feature complete on the strength of the code compiling.

### Data & maintenance

**RULE 31 — When modifying database schema, explain migration implications.**
What data exists, how it migrates, whether the migration is reversible, and what happens to in-flight records.

**RULE 32 — Never delete production data as part of normal development.**
Not to "clean up test data", not to reset a broken state, not for convenience.

**RULE 33 — Prefer maintainable architecture over quick hacks.**
This system will be maintained for years by people who were not in the room.

**RULE 34 — Do not solve a local problem by creating a global architectural problem.**
Adding a global mutable state to fix one screen. Disabling the tenant scope to make one query work. Widening a permission to unblock one feature. All forbidden.

**RULE 35 — If requirements are ambiguous, identify the ambiguity before implementing.**
Do not guess and proceed. Raise it.

---

## DO NOT GUESS

When a requirement is missing, ambiguous, contradictory, or technically dangerous:

**Do not silently invent a solution.** Classify it as `[DECISION REQUIRED]` and state:

- What is unclear
- Why it matters
- Possible options
- Recommended option
- Consequences

### Example

```
[DECISION REQUIRED]

Salary calculation for unpaid leave is not yet defined.

Option A: Deduct the daily wage.
Option B: Deduct according to scheduled working days.

Recommended: Make the policy configurable.

Consequence: a fixed choice will be wrong for some companies and
require a migration later; configurability costs one settings screen now.
```

Then stop and wait. A wrong guess in payroll costs more to unwind than a question costs to ask.

---

## V1 PHILOSOPHY

The first version must be **stable, clean, professional, easy to use, secure, maintainable, and scalable**.

It must **not** attempt to be every possible ERP.

**Do not add**, unless explicitly approved into the MVP: CRM · accounting ledger · procurement · manufacturing · advanced HR · tax management · AI features · complex integrations.

These are future modules. Their absence from V1 is a decision, not an oversight.

---

## SESSION CHECKLIST

At the **start** of every coding session:
1. Read this document.
2. Read the specification for the module being worked on.
3. Read DOCUMENT 24 to confirm the work is in scope.
4. Confirm the phase order in DOCUMENT 25 permits this work now.
5. Check DOCUMENT 28 for any open decision that blocks it.

Before reporting anything **complete**:
1. Server-side permission and tenancy checks present.
2. All four UI states implemented.
3. Input validated server-side.
4. Transactions used where DOCUMENT 06 §8 requires them.
5. Audit records written where DOCUMENT 21 requires them.
6. Tested in Arabic RTL and English LTR.
7. Tested at mobile, tablet, and desktop widths.
8. Tests written per DOCUMENT 26.
9. No hardcoded colours, fonts, working hours, or salary rules.
10. No placeholder content left behind.

---

## RED FLAGS

If any of these appear in a session, stop and reconsider:

- "I'll add a small helper field to make this easier" → RULE 2
- "The specification says X but Y is simpler" → RULE 1, raise it first
- "I'll just disable the tenant scope for this query" → RULE 10, never
- "Rounding here is close enough" → RULE 17
- "I'll skip the empty state for now" → RULE 27
- "Frontend already checks this permission" → RULE 8
- "26 working days is a safe default in code" → RULE 12
- "I'll clean up this unrelated file while I'm here" → RULE 5
- "This colour is close to the token" → RULE 22
- "I'll write the tests after" → DOCUMENT 26, tests accompany the feature
- "The user probably meant…" → RULE 35, ask
