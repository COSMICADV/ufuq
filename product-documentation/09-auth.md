# DOCUMENT 09 — AUTHENTICATION & AUTHORIZATION

## 1. Authentication model

One user account belongs to one company in V1 (assumption A-01, OD-01). Login is email + password, scoped by a unique constraint on `(company_id, email)`.

### Login sequence
1. Rate-limit check by IP and by email.
2. Look up the user by email. If absent, run a dummy hash comparison anyway to keep response timing constant, then fail.
3. Verify the password against the stored hash.
4. Check `user.status` — only `active` proceeds. `invited` and `deactivated` fail with distinct messages.
5. Check `company.status` — only `active` proceeds.
6. Reset `failed_login_count`, set `last_login_at`, create the session, write an audit record.
7. Redirect by role: ADMIN/MANAGER → `/admin`, EMPLOYEE → `/app`.

### Failure handling
- Wrong email and wrong password produce the **same** message.
- After 5 failures within 15 minutes, lock for 15 minutes and set `locked_until`.
- Lockout messages state that the account is temporarily locked, without confirming the email exists.
- Every failed attempt is audited with IP and user agent.

## 2. Password rules

| Rule | Value |
|---|---|
| Minimum length | 10 characters |
| Composition | No forced character-class rules; length and a breach check are more effective |
| Breach check | Reject known-compromised passwords (k-anonymity range API or a local list) |
| Hashing | Argon2id preferred; bcrypt cost ≥ 12 acceptable |
| Storage | Hash only. The plaintext is never logged, never audited, never emailed |
| Change | Requires the current password; invalidates all other sessions |
| Reset | Single-use token, 60-minute expiry, stored hashed |

## 3. Sessions

| Aspect | Rule |
|---|---|
| Mechanism | Server-side session with an httpOnly, Secure, SameSite=Lax cookie for the web client. Bearer tokens for future mobile clients. (OD-02) |
| Idle timeout | 8 hours |
| Absolute timeout | 30 days with "remember me", 24 hours without |
| Rotation | Session identifier rotates on login and on password change |
| Revocation | Logout, password change, role change, and deactivation all invalidate sessions |
| Concurrency | Multiple sessions allowed; a "sign out everywhere" action is available |

Session records store user id, company id, IP, user agent, created and last-seen timestamps.

## 4. Authorization

Three checks run in this order on every protected request:

```
1. AUTHENTICATED  → 401 if not
2. TENANT SCOPE   → 404 if the target row is outside the caller's company
3. PERMISSION     → 403 if the role lacks the permission
4. OWNERSHIP SCOPE → 403 if the permission's scope does not reach the target row
```

### Tenant scoping
Implemented as a **global query scope at the data-access layer**, applied automatically to every model that carries `company_id`. A developer who forgets a `where` clause still cannot leak another company's data. Bypassing the scope requires an explicit, greppable call that appears only in platform-level code.

### Permission checking
Permissions are loaded once per request from the user's role and cached for the request lifetime. Each endpoint declares its requirement in one place — middleware or a policy class — never as ad-hoc `if` statements sprinkled through controllers.

### Ownership scope resolution
Scope is converted into a query constraint before fetching:

| Scope | Constraint |
|---|---|
| self | `employee_id = :caller_employee_id` |
| team | `employee_id IN (SELECT id FROM employees WHERE manager_id = :caller_employee_id)` |
| company | no additional constraint beyond the tenant scope |

Never fetch a broad set and filter it in application code. Never filter in the frontend.

## 5. Frontend permission handling

The frontend receives the permission list from `/auth/me` and uses it **only** to decide what to render. This is a usability affordance. It carries no security weight.

Explicit consequence: if a developer removes a frontend permission check, no data is exposed. If a developer removes a server-side check, data is exposed. The server check is the control; the client check is decoration.

## 6. Account lifecycle

```
Admin creates employee
   └─ user created with status = invited, password_hash = null
      └─ invitation email with a single-use token (72-hour expiry)
         ├─ accepted  → password set, status = active
         └─ expired   → admin resends; the old token is invalidated
```

**Deactivation:** sets `status = deactivated`, invalidates all sessions immediately, blocks login. The employment record, attendance history, and payroll history are all retained.

**Reactivation:** sets `status = active`. If the password was never set, a fresh invitation is issued.

**Guard:** the last active ADMIN in a company cannot be deactivated or demoted. Enforced server-side, not by hiding the button.

## 7. Company isolation

| Control | Implementation |
|---|---|
| Data | Global tenant scope on every business model |
| Session | `company_id` bound into the session at login; never read from the request |
| Files | Attachment paths include the company identifier; access checks tenant before streaming |
| Cache | Cache keys are namespaced by company |
| Background jobs | Jobs carry `company_id` explicitly and re-apply the scope on execution |
| Reports | Aggregations are built on scoped queries, never raw cross-tenant SQL |
| Errors | Cross-tenant references return 404 |

Cross-tenant leakage is the highest-severity defect class in this system. DOCUMENT 26 requires a dedicated tenancy test suite covering every endpoint.

## 8. What must never be exposed

- Password hashes, reset tokens, invitation tokens, session identifiers.
- Salary data to anyone other than the employee themselves, an ADMIN, or a future role explicitly granted `employee.view_salary`.
- Any record belonging to another company, in any response, error message, log line, or export.
- Employee personal data beyond what the caller's scope permits — a MANAGER sees their team, not the whole company.
- Internal exception messages, stack traces, SQL, or file paths in any API response.

## 9. Audit requirements for auth

Audited: login success, login failure, lockout, logout, password change, password reset request, password reset completion, invitation sent, invitation accepted, role change, activation, deactivation, session revocation.

Each record captures user, action, IP, user agent, timestamp. Password values are never captured.

## 10. Future considerations (not V1)

Documented so the architecture does not preclude them: two-factor authentication, SSO/SAML for larger clients, a user belonging to multiple companies (requires a `company_users` membership table), API keys for integrations, and device-trust for mobile attendance. None of these are built in V1.
