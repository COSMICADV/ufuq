# DOCUMENT 20 — SECURITY SPECIFICATION

> Authentication existing is not the same as the system being secure. This document lists what must actually be implemented and verified.

## 1. Authentication
Covered fully in DOCUMENT 09. Summary of controls: Argon2id or bcrypt(≥12) hashing · constant-time comparison and dummy hashing on unknown emails · rate limiting per IP and per email · lockout after 5 failures in 15 minutes · single-use hashed tokens with expiry for reset and invitation · session rotation on privilege change · full session revocation on password change, role change, and deactivation.

## 2. Authorization
- Every protected endpoint declares a required permission in one place.
- Permission checks run server-side on every request. Frontend checks are cosmetic.
- Ownership scope is resolved into a query constraint before fetching, never as a post-fetch filter.
- Object-level checks on every `:id` route — holding `task.view` does not grant access to *that* task if it is out of scope.
- Authorization tests exist per endpoint per role (DOCUMENT 26).

## 3. Company data isolation
The highest-severity defect class in this product.

| Control | Implementation |
|---|---|
| Query layer | Automatic global tenant scope on every model carrying `company_id` |
| Session | `company_id` bound at login; never read from a request parameter |
| Files | Company-namespaced paths, authorization-checked streaming |
| Cache | Company-namespaced keys |
| Background jobs | Carry and re-apply `company_id` |
| Errors | Cross-tenant references return 404, not 403 |
| Tests | A dedicated tenancy suite hitting every endpoint with a foreign record id |

## 4. Input validation
- Server-side validation on every endpoint. No exceptions.
- Whitelist validation — reject unknown fields rather than ignoring them.
- Type, length, format, range, and enum checks matching the database schema.
- Referenced ids validated for tenancy **before** any business logic runs.
- Arabic-Indic digits normalised for numeric input.
- Control characters and null bytes rejected.
- Uploaded file names sanitised and never used as storage paths.

## 5. Injection prevention
| Vector | Control |
|---|---|
| SQL | Parameterised queries or an ORM exclusively. No string-concatenated SQL, ever. Dynamic `ORDER BY` uses a whitelist |
| XSS | Context-aware output escaping; no raw HTML injection from user content; a strict Content Security Policy |
| Command | No shell invocation with user input |
| Path traversal | Generated storage keys, never user-supplied paths |
| SSRF | No user-controlled outbound URLs in V1; if added, an allowlist |
| Template | No user input in template compilation |

## 6. Session & transport security
- HTTPS everywhere; HSTS with a long max-age.
- Cookies: `httpOnly`, `Secure`, `SameSite=Lax`.
- CSRF tokens on all state-changing requests for the cookie-authenticated web client.
- Session identifiers are cryptographically random, at least 128 bits of entropy.
- No sensitive data in URLs, query strings, or referrer headers.

## 7. File upload security
| Control | Rule |
|---|---|
| Type | Allowlist by MIME **and** magic bytes, not by extension |
| Allowed | PDF, PNG, JPG, WebP, DOCX, XLSX |
| Size | 10 MB per file, configurable |
| Storage | Outside the web root, with generated non-guessable keys |
| Serving | Through an authorization-checked endpoint only. Never a public URL |
| Scanning | Malware scanning where available |
| Execution | Storage must not execute anything; images are never processed by an interpreter |
| Naming | Original name stored as metadata only |

Guessing a URL must never yield another company's attachment. This is tested explicitly.

## 8. Sensitive data protection
| Data | Treatment |
|---|---|
| Passwords | Hashed only. Never logged, never audited, never emailed |
| Tokens | Stored hashed, single-use, time-limited |
| Salary | Visible only to the employee, an ADMIN, or a role explicitly granted `employee.view_salary` |
| Personal data | Scoped by role; a manager sees their team, not the company |
| Audit values | Sensitive fields excluded from `old_values` / `new_values` |
| Logs | No passwords, tokens, session ids, or full salary records in application logs |
| Errors | No stack traces, SQL, internal ids, or file paths in API responses |

## 9. Rate limiting
Per DOCUMENT 08 §6. Applied at the edge where possible and in the application as a backstop. Exceeding a limit returns 429 with a `Retry-After` header, and repeated abuse is logged.

## 10. Audit & monitoring
- All material actions audited per DOCUMENT 21.
- Security events specifically: login failures, lockouts, permission denials, cross-tenant attempts, file access denials.
- Alerting on: repeated permission denials from one user, cross-tenant access attempts, unusual export volume, and payroll finalization outside business hours.

## 11. Dependency & infrastructure
- Automated dependency vulnerability scanning in CI; builds fail on high-severity findings.
- Secrets in a secret manager or environment variables. Never in source control.
- Separate credentials per environment.
- Database not publicly reachable.
- Principle of least privilege on all service accounts.
- Backups encrypted at rest, with a **tested** restore procedure — an untested backup is not a backup.

## 12. Security testing requirements
Required before launch:
1. Authorization matrix test — every endpoint × every role.
2. Tenancy isolation test — every endpoint with a foreign company's record id.
3. Injection test suite — SQL, XSS, path traversal.
4. File upload abuse test — wrong type, oversized, malicious name, direct URL access.
5. Rate limit verification.
6. Session lifecycle test — expiry, revocation, fixation.
7. Sensitive data exposure review of every API response shape.
8. Third-party penetration test before production launch with paying customers.

## 13. Incident response
A documented procedure covering: detection, containment, assessment of affected companies, customer notification obligations, and post-incident review. Written before launch, not after the first incident.

## 14. Known accepted risks (V1)
| Risk | Rationale | Mitigation |
|---|---|---|
| No 2FA | Reduces V1 scope | Strong password policy, lockout, session controls. 2FA planned |
| Self-reported attendance | No hardware integration in V1 | Audit trail and manager review |
| Single admin role holds broad power | Small-company reality | Full audit trail of every admin action |
| No field-level encryption on salary | Complexity vs benefit at this scale | Database-level encryption at rest, strict access control |

Each is a conscious decision, documented here so it is not mistaken for an oversight.
